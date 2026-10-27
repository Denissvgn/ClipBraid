import { chromium } from '@playwright/test';
import { readFile, writeFile, appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { repositoryState, sourceIdentity } from './source-identity.mjs';
import { diagnosticOptions, diagnosticBuild, verifyDiagnosticServer, diagnosticComplete, observerStopped, digest } from './diagnostic-policy.mjs';
import os from 'node:os';

const options=diagnosticOptions(process.argv.slice(2));
const evidence=diagnosticBuild(),inputInfo=await stat(options.input);
if(!inputInfo.isFile()||inputInfo.size>256*1048576)throw new Error('Diagnostic input must be a project file of at most 256 MiB.');
const inputSha256=digest(await readFile(options.input));
await mkdir(options.folder,{recursive:true});
const result={schemaVersion:1,status:'failed',...repositoryState(),sourceInputsSha256:evidence.identity.sha256,
  lockfileSha256:await readFile('package-lock.json').then(digest,()=>null),inputSha256,buildId:evidence.build.buildId,
  quality:options.quality,plan:options.plan,timeoutMs:options.timeoutMs,baseURL:options.baseURL,
  scope:'Export/structure/delivery diagnostics only; full-reference pictures/listening and physical device/Flow qualification remain separate.',
  environment:{node:process.version,os:`${os.platform()} ${os.release()} ${os.arch()}`,acceleration:'unqualified',coreTransport:'Pinned local FFmpeg core bytes replace CDN transport'},
  state:null,errors:[],integrityErrors:[],servedResources:[],verifiedArtifacts:[],coreAssets:[],received:null,deadlineReached:false};
let browser,page,download,lastSummary;const pending=[],trace=[];
async function drain(){
  let next=0;
  while(next<pending.length){
    const end=pending.length;let timer;
    try{await Promise.race([Promise.allSettled(pending.slice(next,end)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Served resource hashing timed out.')),5000)})])}
    finally{clearTimeout(timer)}next=end;
  }
}
async function summary(stopped=false){
  const report=stopped?observerStopped(lastSummary):await page.locator('#export-diagnostic-report').evaluate(element=>JSON.parse(element.textContent));
  if(!report?.jobId||report.buildId!==evidence.build.buildId)return;
  lastSummary=report;
  await mkdir('reports/diagnostics',{recursive:true});const temporary=`reports/diagnostics/latest.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(report,null,2));await rename(temporary,'reports/diagnostics/latest.json');
}
try{
  const launchArgs=['--autoplay-policy=no-user-gesture-required',...(options.software?['--disable-gpu','--disable-accelerated-video-encode','--disable-accelerated-video-decode']:[])];
  result.environment.launchArgs=launchArgs;
  if(options.software)result.environment.acceleration='GPU and accelerated video encode/decode disabled by Chromium launch flags; hardware unqualified';
  browser=await chromium.launch({channel:'chromium',headless:true,args:launchArgs});
  result.environment.browser=browser.version();page=await browser.newPage();
  const session=await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  page.on('pageerror',error=>result.errors.push(String(error)));
  const expected=new Map(evidence.build.files.map(file=>[new URL(file.path,options.baseURL).href,file]));
  const indexArtifact=evidence.build.files.find(file=>file.path==='index.html'),origin=new URL(options.baseURL).origin;
  expected.set(options.baseURL,indexArtifact);
  page.on('response',response=>{pending.push((async()=>{
    const url=new URL(response.url()),type=response.request().resourceType();
    const file=expected.get(response.url())??(type==='document'&&url.origin===origin?indexArtifact:undefined);
    if(!file){if(['http:','https:'].includes(url.protocol)&&url.origin===origin&&type==='script')result.integrityErrors.push(`Unlisted served script: ${url.pathname}`);return}
    try{
      const bytes=await response.body(),sha256=digest(bytes);
      result.servedResources.push({url:response.url(),bytes:bytes.length,sha256});
      if(bytes.length!==file.bytes||sha256!==file.sha256)result.integrityErrors.push(`Served artifact changed: ${file.path}`);
    }catch(error){result.integrityErrors.push(String(error))}
  })())});
  page.on('download',value=>{download=value});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),cdn=/^\/@ffmpeg\/core@0\.12\.6\/dist\/umd\/(ffmpeg-core\.(js|wasm))$/.exec(url.pathname);
    const match=url.origin===origin?/\/(ffmpeg-core\.(js|wasm))$/.exec(url.pathname):url.hostname==='unpkg.com'?cdn:null;
    if(match){
      const bytes=await readFile(`node_modules/@ffmpeg/core/dist/umd/${match[1]}`),sha256=digest(bytes);
      const previous=result.coreAssets.find(asset=>asset.name===match[1]);
      if(previous&&previous.sha256!==sha256)result.integrityErrors.push('FFmpeg core assets changed during diagnosis.');
      if(!previous)result.coreAssets.push({name:match[1],bytes:bytes.length,sha256});
      await route.fulfill({body:bytes,contentType:match[2]==='wasm'?'application/wasm':'text/javascript',headers:{'access-control-allow-origin':'*'}});
    }
    else if(url.origin===origin)await route.continue();
    else await route.abort();
  });
  // Verify all expected bytes before exposing the input to this page.
  result.verifiedArtifacts=await verifyDiagnosticServer(page.request,options.baseURL,evidence.build);
  await page.goto(options.baseURL);await page.getByRole('button',{name:'Start editing',exact:true}).click();
  if(new URL(page.url()).origin!==origin)throw new Error('Diagnostic page redirected outside the local build origin.');
  if(await page.locator('.editor-app').getAttribute('data-build-id')!==evidence.build.buildId)throw new Error('Served application build identity mismatch.');
  await drain();if(result.integrityErrors.length)throw new Error('Served build integrity failed before input upload.');
  await page.locator('input[accept=".json"]').setInputFiles(options.input);
  await page.locator('[data-editor-status="READY"]').waitFor({state:'visible',timeout:30000});
  await page.getByRole('button',{name:options.quality,exact:true}).click();
  await page.getByRole('checkbox',{name:'Compatibility render (one encoder)',exact:true}).setChecked(options.plan==='single');
  await drain();if(result.integrityErrors.length)throw new Error('Served build integrity failed before export.');
  await page.getByRole('button',{name:'Export video',exact:true}).click();
  const started=Date.now();
  while(Date.now()-started<options.timeoutMs){
    await page.waitForTimeout(1000);result.state=await page.locator('#export-evidence').evaluate(element=>JSON.parse(element.textContent));
    await summary();const metrics=await session.send('Performance.getMetrics');
    const heap=metrics.metrics.find(metric=>metric.name==='JSHeapUsedSize')?.value;
    const point={wallMs:Date.now()-started,...result.state,resources:{pageJsHeapBytes:Number.isFinite(heap)?heap:null}};trace.push(point);
    await appendFile(`${options.folder}/trace.jsonl`,JSON.stringify(point)+'\n');
    if(!result.state.active)break;
  }
  if(result.state?.active){
    result.deadlineReached=true;
    if(result.state.cancellable){
      try{await page.getByRole('button',{name:'Cancel export',exact:true}).click({timeout:1000})}catch{}
      try{await page.waitForFunction(()=>!JSON.parse(document.querySelector('#export-evidence').textContent).active,null,{timeout:7500})}catch{}
      result.state=await page.locator('#export-evidence').evaluate(element=>JSON.parse(element.textContent));await summary();
    }
  }
  if(download){
    await download.saveAs(`${options.folder}/output.mp4`);const bytes=await readFile(`${options.folder}/output.mp4`);
    result.received={bytes:bytes.length,sha256:digest(bytes),failure:await download.failure()};
  }
  await drain();
  if(sourceIdentity().sha256!==evidence.identity.sha256)result.integrityErrors.push('Source inputs changed during diagnosis.');
  if(digest(await readFile(options.input))!==inputSha256)result.integrityErrors.push('Input file changed during diagnosis.');
  result.status=!result.deadlineReached&&!result.errors.length&&!result.integrityErrors.length&&diagnosticComplete(result.state,result.received,evidence.build.buildId)?'passed':'failed';
  result.wallMs=Date.now()-started;
}catch(error){result.error=String(error)}
finally{
  try{
    try{await drain()}catch(error){result.error??=String(error);result.status='failed'}
    if(result.state?.active)try{await summary(true)}catch(error){result.error??=String(error);result.status='failed'}
    if(result.integrityErrors.length)result.status='failed';
    await writeFile(`${options.folder}/trace.json`,JSON.stringify(trace));
    await writeFile(`${options.folder}/result.json`,JSON.stringify(result,null,2));
  }finally{await browser?.close()}
}
process.exitCode=result.status==='passed'?0:1;
console.log(JSON.stringify({status:result.status,phase:result.state?.phase,error:result.error??result.state?.error,
  integrityErrors:result.integrityErrors,wallMs:result.wallMs,received:result.received,buildId:result.buildId}));
