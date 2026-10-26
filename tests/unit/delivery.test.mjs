import test from "node:test";
import assert from "node:assert/strict";
import { loadDelivery } from "../source-probes.mjs";
test("delivery receipts distinguish browser initiation, host acceptance and error categories", async () => {
  for (const [response, hosted, outcome, category] of [[true,false,"download-started"], [true,true,"host-accepted"],
    [{accepted:true},true,"host-accepted"], [false,true,null,"rejected"], [null,true,null,"unknown"],
    [undefined,true,null,"unknown"], [{cancelled:true},true,null,"cancelled"], [{success:true},true,null,"unknown"]]) {
    const { deliverVideo } = loadDelivery({ Flow: { save: async () => response }, isHostedFlow: () => hosted });
    if (outcome) assert.equal((await deliverVideo({ base64: "AQ==", mimeType:"video/mp4", name:"video.mp4" })).outcome,outcome);
    else await assert.rejects(deliverVideo({base64:"AQ==",mimeType:"video/mp4",name:"video.mp4"}), error => error.category===category);
  }
  for (const [name, category] of [["AbortError","cancelled"],["NotAllowedError","denied"],["NotSupportedError","unsupported"],["Error","transport"]]) {
    const { deliverVideo } = loadDelivery({ Flow: { save: async () => { const e=new Error("fault");e.name=name;throw e; } }, isHostedFlow: () => true });
    await assert.rejects(deliverVideo({base64:"AQ==",mimeType:"video/mp4",name:"video.mp4"}), error=>error.category===category);
  }
});
