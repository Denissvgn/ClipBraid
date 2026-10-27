import test from "node:test";
import assert from "node:assert/strict";
import {loadModule} from "../source-probes.mjs";
const {platformFailure,abortable}=loadModule("services/platformError.ts");
test("platform categories preserve cancellation, denial, unsupported and transport",()=>{
  for(const [name,category]of [["AbortError","cancelled"],["SecurityError","denied"],["NotAllowedError","denied"],["NotFoundError","unsupported"],["NotSupportedError","unsupported"],["Error","transport"]]){
    const error=new Error("fault");error.name=name;assert.equal(platformFailure(error).category,category);
  }
});
test("cancellation settles promptly and late permission results are disposed",async()=>{
  const controller=new AbortController();let resolve,stopped=false;
  const pending=abortable(new Promise(value=>{resolve=value}),controller.signal,()=>{stopped=true});
  controller.abort();await assert.rejects(pending,error=>error.category==="cancelled");resolve({});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(stopped,true);
});
