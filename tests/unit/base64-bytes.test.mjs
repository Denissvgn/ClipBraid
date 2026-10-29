import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadModule } from "../source-probes.mjs";

const { decodeBase64Bytes } = loadModule("services/base64Bytes.ts");

test("transport decoding preserves every byte and padding", () => {
  for (const length of [0, 1, 2, 3, 256, 257]) {
    const expected = Buffer.from(Array.from({ length }, (_, index) => index % 256));
    assert.deepEqual(Buffer.from(decodeBase64Bytes(expected.toString("base64"))), expected);
  }
});

test("invalid transport encoding remains rejected", () => {
  assert.throws(() => decodeBase64Bytes("invalid%payload"));
});

test("a large transport payload decodes within a bounded JavaScript heap", () => {
  const size = 32 * 1048576;
  const expected = createHash("sha256").update(Buffer.alloc(size, 165)).digest("hex");
  const source = `import {createHash} from "node:crypto";
    const decode = (${decodeBase64Bytes.toString()});
    const encoded = Buffer.alloc(${size},165).toString("base64");
    const result = decode(encoded);
    console.log(JSON.stringify({bytes:result.length,sha256:createHash("sha256").update(result).digest("hex")}));`;
  const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `Decoder exited with ${child.signal ?? child.status}: ${child.stderr.slice(-1500)}`);
  assert.deepEqual(JSON.parse(child.stdout), { bytes: size, sha256: expected });
});
