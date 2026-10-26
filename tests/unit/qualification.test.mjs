import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPlaywright, REQUIRED_BROWSER_SPECS } from '../../scripts/qualification-policy.mjs';
const report=(expectedStatus='passed',status='expected',result='passed')=>({suites:[{specs:[{file:'export.spec.mjs',title:'real export',tests:[{expectedStatus,status,results:[{status:result}]}]}]}]});
test('qualification rejects empty, skipped, expected-failure and partial full-suite evidence',()=>{
  assert.equal(assessPlaywright(report()).valid,true);
  assert.equal(assessPlaywright({suites:[]}).valid,false);
  const listedOnly=report();listedOnly.suites[0].specs[0].tests[0].results=[];
  assert.equal(assessPlaywright(listedOnly).valid,false);
  assert.equal(assessPlaywright(report('failed','expected','failed')).valid,false);
  assert.equal(assessPlaywright(report('skipped','skipped','skipped')).valid,false);
  assert.equal(assessPlaywright(report('passed','unexpected','failed')).valid,false);
  assert.equal(assessPlaywright(report(),true).valid,false);
  assert.ok(assessPlaywright(report(),true).missingSpecs.includes('cancellation.spec.mjs'));
  const complete={suites:[{specs:REQUIRED_BROWSER_SPECS.map(file=>({...report().suites[0].specs[0],file}))}]};
  assert.equal(assessPlaywright(complete,true).valid,true);
});
