import { sourceIdentity, repositoryState } from './source-identity.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { assessPlaywright, assessSmokeEvidence, processSucceeded } from './qualification-policy.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runId=randomUUID();mkdirSync('reports',{recursive:true});
const { inputs }=sourceIdentity();
const source={...repositoryState(),inputsSha256:sha(JSON.stringify(inputs))};
rmSync('reports/browser-results.json',{force:true});
rmSync('reports/browser-manifest.json',{force:true});
rmSync('test-results',{recursive:true,force:true});
const result=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test',...process.argv.slice(2)],{stdio:'inherit',timeout:960000,env:{...process.env,CLIPBRAID_RUN_ID:runId}});
let report;try{report=JSON.parse(readFileSync('reports/browser-results.json','utf8'));}catch{}
const assessment=assessPlaywright(report,process.argv.length===2),testResults=assessment.tests;
const smoke=testResults.find(t=>t.title.startsWith('one-second repeated-source'));
let smokeEvidence=null;
try{const attached=smoke?.results.flatMap(result=>result.attachments??[]).find(attachment=>attachment.name==='output-evidence');if(attached?.body)smokeEvidence=JSON.parse(Buffer.from(attached.body,'base64').toString())}catch{}
const smokePassed=smoke?.expectedStatus==='passed'&&smoke.status==='expected'&&smoke.results.length>0&&smoke.results.every(r=>r.status==='passed')&&assessSmokeEvidence(smokeEvidence,source.inputsSha256);
const evidenceStatus=smokePassed?'passed':'not-run';
function artifactInventory(dir){try{return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?artifactInventory(`${dir}/${e.name}`):e.isFile()?[{path:`${dir}/${e.name}`,bytes:readFileSync(`${dir}/${e.name}`).length,sha256:sha(readFileSync(`${dir}/${e.name}`))}]:[]);}catch(error){if(error.code==='ENOENT')return [];throw error}}
const artifacts=[{path:'reports/browser-results.json',sha256:report?sha(readFileSync('reports/browser-results.json')):null},...artifactInventory('test-results')];
const manifest={schemaVersion:1,recordedAt:new Date().toISOString(),runId,jobId:null,source,lockfileSha256:sha(readFileSync('package-lock.json')),environment:{os:`${os.platform()} ${os.release()} ${os.arch()}`,node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),host:'standalone Chromium; exact CDN core mirrored locally',browser:JSON.parse(readFileSync('node_modules/playwright-core/browsers.json')).browsers.find(b=>b.name==='chromium'),codecMode:'actual WebCodecs; acceleration unqualified'},inputs:JSON.parse(readFileSync('tests/fixtures/manifest.json')),sourceInputs:inputs,result:result.status===0&&report?'passed':'failed',claims:{build:'not-run',structure:evidenceStatus,pictures:evidenceStatus,sound:evidenceStatus,delivery:evidenceStatus,device:'not-run'},claimScope:'One-second synthetic smoke only; known defects remain open',deliveryBoundary:smokePassed?'download-initiated':'not-run',knownFailures:testResults.filter(t=>t.expectedStatus==='failed').map(t=>t.title),servedBundles:testResults.flatMap(t=>t.results.flatMap(r=>r.attachments??[]).filter(a=>a.name==='served-resources').map(a=>a.body?JSON.parse(Buffer.from(a.body,'base64').toString()):{path:a.path})),tests:testResults,artifacts,error:result.error?.message};
manifest.result=processSucceeded(result)&&assessment.valid&&(process.argv.length!==2||smokePassed)&&(!smokePassed||artifacts.some(item=>item.path.startsWith('test-results/')&&item.sha256===smokeEvidence.sha256&&item.bytes===smokeEvidence.bytes))?'passed':'failed';
manifest.jobs=smokePassed?[smokeEvidence]:[];
manifest.environment.browserProcessScope='One spec file per worker/browser project; one worker, zero retries';
manifest.summary={total:assessment.total,passed:assessment.passed,skipped:assessment.skipped,expectedFailures:assessment.expectedFailures,missingSpecs:assessment.missingSpecs,globalErrors:assessment.globalErrors};
manifest.claimScope='Stream/frame/PCM/delivery claims apply to the one-second repeated-source smoke artifact; all regression results are listed separately. Full-reference visual/listening and physical device/Flow qualification remain separate.';
writeFileSync('reports/browser-manifest.tmp',JSON.stringify(manifest,null,2)+'\n');
renameSync('reports/browser-manifest.tmp','reports/browser-manifest.json');
process.exitCode=manifest.result==='passed'?0:1;
