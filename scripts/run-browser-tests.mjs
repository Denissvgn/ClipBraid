import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runId=randomUUID();mkdirSync('reports',{recursive:true});
const sourcePaths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const inputs=[...new Set(sourcePaths)].filter(path=>/\.(tsx?|m?js|css|html|json|ya?ml)$/.test(path)||['.node-version','.npmrc'].includes(path)).filter(path=>!path.startsWith('test-data/')).sort().map(path=>({path,sha256:sha(readFileSync(path))}));
const source={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),inputsSha256:sha(JSON.stringify(inputs))};
rmSync('reports/browser-results.json',{force:true});
rmSync('reports/browser-manifest.json',{force:true});
const result=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test',...process.argv.slice(2)],{stdio:'inherit',timeout:240000,env:{...process.env,CLIPBRAID_RUN_ID:runId}});
let report;try{report=JSON.parse(readFileSync('reports/browser-results.json','utf8'));}catch{}
const testResults=[];
function collect(suite){for(const spec of suite.specs??[])for(const t of spec.tests??[])testResults.push({title:spec.title,expectedStatus:t.expectedStatus,status:t.status,results:t.results});for(const sub of suite.suites??[])collect(sub);}
for(const suite of report?.suites??[])collect(suite);
const smoke=testResults.find(t=>t.title.startsWith('one-second repeated-source'));
const smokePassed=smoke?.status==='expected'&&smoke.results.every(r=>r.status==='passed');
const evidenceStatus=smokePassed?'passed':'not-run';
function artifactInventory(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?artifactInventory(`${dir}/${e.name}`):[{path:`${dir}/${e.name}`,bytes:readFileSync(`${dir}/${e.name}`).length,sha256:sha(readFileSync(`${dir}/${e.name}`))}]);}
const artifacts=[{path:'reports/browser-results.json',sha256:report?sha(readFileSync('reports/browser-results.json')):null},...artifactInventory('test-results')];
const manifest={schemaVersion:1,recordedAt:new Date().toISOString(),runId,jobId:null,source,lockfileSha256:sha(readFileSync('package-lock.json')),environment:{os:`${os.platform()} ${os.release()} ${os.arch()}`,node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),host:'standalone Chromium; exact CDN core mirrored locally',browser:JSON.parse(readFileSync('node_modules/playwright-core/browsers.json')).browsers.find(b=>b.name==='chromium'),codecMode:'actual WebCodecs; acceleration unqualified'},inputs:JSON.parse(readFileSync('tests/fixtures/manifest.json')),sourceInputs:inputs,result:result.status===0&&report?'passed':'failed',claims:{build:'not-run',structure:evidenceStatus,pictures:evidenceStatus,sound:evidenceStatus,delivery:evidenceStatus,device:'not-run'},claimScope:'One-second synthetic smoke only; known defects remain open',deliveryBoundary:smokePassed?'download-initiated':'not-run',knownFailures:testResults.filter(t=>t.expectedStatus==='failed').map(t=>t.title),servedBundles:testResults.flatMap(t=>t.results.flatMap(r=>r.attachments??[]).filter(a=>a.name==='served-resources').map(a=>a.body?JSON.parse(Buffer.from(a.body,'base64').toString()):{path:a.path})),tests:testResults,artifacts,error:result.error?.message};
writeFileSync('reports/browser-manifest.json',JSON.stringify(manifest,null,2)+'\n');
process.exitCode=report?(result.status??1):1;
