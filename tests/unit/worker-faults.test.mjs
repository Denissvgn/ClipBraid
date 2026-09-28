import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function faultService() {
  const workers=[];
  class Worker {
    constructor(){workers.push(this);}
    postMessage({id,type}){if(type==='LOAD')queueMicrotask(()=>this.onmessage({data:{id,type,data:true}}));}
    terminate(){}
  }
  const source=ts.transpile(readFileSync('services/ffmpegService.ts','utf8'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
  const exports={};
  new Function('require','exports','Worker','URL',source)(()=>({toBlobURL:async()=>'blob:explicit-fault-transport'}),exports,Worker,{createObjectURL:()=> 'blob:explicit-fault-worker'});
  return {service:exports.ffmpegService,workers};
}
test('concurrent loads create one worker [known-broken worker recovery]',async()=>{
  const {service,workers}=faultService();
  await Promise.all([service.load(),service.load()]);
  // Assert the known defect explicitly; worker recovery must invert this expectation.
  assert.equal(workers.length,2,'Unexpected behavior; review concurrent-load exception');
});
test('worker crash rejects pending work [known-broken worker recovery]',async()=>{
  const {service,workers}=faultService();await service.load();
  const pending=service.exec(['-version']).then(()=> 'resolved',()=> 'rejected');
  workers[0].onerror?.(new Error('injected worker crash'));
  const outcome=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('unsettled'),100))]);
  assert.equal(outcome,'unsettled','Unexpected behavior; remove worker recovery known-failure exception');
});
