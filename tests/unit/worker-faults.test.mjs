import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
function faultService(control = {}, timeouts = {}) {
  const workers = [],
    revoked = [],
    urls = [];
  class Worker {
    messages = [];
    terminated = false;
    constructor() {
      workers.push(this);
    }
    reply(message, data, type = message.type) {
      this.onmessage?.({ data: { id: message.id, type, data } });
    }
    postMessage(message) {
      if (control.throwPost && message.type !== "LOAD")
        throw new Error("postMessage failed");
      this.messages.push(message);
      if (message.type === "LOAD") {
        if (control.hangLoad) return;
        queueMicrotask(() =>
          this.reply(
            message,
            control.failFirstLoad && workers.length === 1
              ? "load failed"
              : true,
            control.failFirstLoad && workers.length === 1 ? "ERROR" : "LOAD",
          ),
        );
      }
    }
    terminate() {
      this.terminated = true;
    }
  }
  class MockURL extends URL {
    static createObjectURL() {
      const url = `blob:test-${urls.length}`;
      urls.push(url);
      return url;
    }
    static revokeObjectURL(url) {
      revoked.push(url);
    }
  }
  const fetch = async () => ({
    ok: !control.failFetch,
    status: control.failFetch ? 503 : 200,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  const source = ts.transpile(
    readFileSync("services/ffmpegService.ts", "utf8"),
    { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  );
  const exports = {};
  new Function("exports", "Worker", "URL", "fetch", source)(
    exports,
    Worker,
    MockURL,
    fetch,
  );
  return {
    service: new exports.FFmpegService({
      loadMs: 100,
      operationMs: 100,
      ...timeouts,
    }),
    workers,
    revoked,
    urls,
  };
}
test("concurrent loads share one promise and one worker", async () => {
  const { service, workers } = faultService();
  const first = service.load(),
    second = service.load();
  assert.equal(first, second);
  await Promise.all([first, second, service.load()]);
  assert.equal(workers.length, 1);
  await service.load();
  assert.equal(workers.length, 1);
});
for (const event of ["onerror", "onmessageerror"])
  test(`${event} rejects all pending work, frees URLs and permits a new worker`, async () => {
    const { service, workers, revoked } = faultService();
    await service.load();
    const results = Promise.allSettled([
      service.exec(["-version"]),
      service.readFile("pending"),
    ]);
    const staleMessage = workers[0].onmessage;
    workers[0][event]({ message: "injected crash", preventDefault() {} });
    assert.deepEqual(
      (await results).map((r) => r.status),
      ["rejected", "rejected"],
    );
    assert.equal(workers[0].terminated, true);
    assert.equal(revoked.length, 3);
    await service.load();
    assert.equal(workers.length, 2);
    const pending = service.exec(["-version"]);
    const message = workers[1].messages.at(-1);
    staleMessage({ data: { ...message, data: 99 } });
    workers[1].reply(message, 0);
    assert.equal(await pending, 0);
  });
test("load fallback owns and disposes only its own worker", async () => {
  const { service, workers, revoked } = faultService({ failFirstLoad: true });
  await Promise.all([service.load(), service.load()]);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, false);
  assert.equal(revoked.length, 3);
});
test("failed fetches reject loading and clear the in-flight guard for retry", async () => {
  const control = { failFetch: true };
  const { service, workers } = faultService(control);
  await assert.rejects(service.load(), /HTTP 503/);
  assert.equal(workers.length, 0);
  control.failFetch = false;
  await service.load();
  assert.equal(workers.length, 1);
});
test("postMessage exceptions settle every callback and allow retry", async () => {
  const control = { throwPost: false };
  const { service, workers } = faultService(control);
  await service.load();
  const first = service.readFile("pending");
  control.throwPost = true;
  const results = await Promise.allSettled([first, service.exec(["-version"])]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
  );
  control.throwPost = false;
  await service.load();
  assert.equal(workers.length, 2);
});
test("unresponsive loading and operations time out and release resources", async () => {
  const loading = faultService({ hangLoad: true }, { loadMs: 10 });
  await assert.rejects(loading.service.load(), /timed out/);
  assert.equal(loading.workers.length, 3);
  assert.ok(loading.workers.every((w) => w.terminated));
  assert.equal(loading.revoked.length, 9);
  const running = faultService({}, { operationMs: 10 });
  await running.service.load();
  await assert.rejects(running.service.exec(["-version"]), /timed out/);
  assert.equal(running.workers[0].terminated, true);
  await running.service.load();
  assert.equal(running.workers.length, 2);
});
