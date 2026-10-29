import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { sourceIdentity } from '../../scripts/source-identity.mjs';
import { preview } from 'vite';
import { asset, draft } from '../browser/fixtures.mjs';

const temporary=await mkdtemp(path.join(tmpdir(),'clipbraid-diagnostic-fixture-'));
let uploads=0;
const sourceScript='console.log("expected public bundle");';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let html='',production;
function runCli(cwd,url,input,folder,timeout='2000'){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/diagnose-export.mjs',import.meta.url)),input,folder,'draft','auto',timeout],{
      cwd,env:{...process.env,CLIPBRAID_DIAGNOSTIC_URL:url},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',
    });
    let output='',timedOut=false,hardStop;
    const stop=signal=>{try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal)}catch{}};
    const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');hardStop=setTimeout(()=>stop('SIGKILL'),500)},30000);
    child.stdout.on('data',bytes=>{output=(output+bytes).slice(-128*1024)});child.stderr.on('data',bytes=>{output=(output+bytes).slice(-128*1024)});
    child.on('error',error=>{output+=String(error)});
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(hardStop);resolve({exitCode,signal,timedOut,output})});
  });
}
const server=createServer((request,response)=>{
  if(request.url==='/uploaded'){uploads++;response.writeHead(200,{'content-type':'application/json'});response.end('{}');return}
  if(request.url==='/assets/index-12345678.js'){
    response.writeHead(200,{'content-type':'application/javascript'});response.end('console.log("a different served bundle");');return;
  }
  if(request.url==='/'||request.url==='/index.html'){
    response.writeHead(200,{'content-type':'text/html'});response.end(html);return;
  }
  response.writeHead(404);response.end('Not found');
});
try{
  await mkdir(path.join(temporary,'reports'),{recursive:true});await mkdir(path.join(temporary,'dist/assets'),{recursive:true});
  await writeFile(path.join(temporary,'App.tsx'),'export const fixture = true;\n');
  await writeFile(path.join(temporary,'.gitignore'),'reports/\ndist/\n');
  const source=sourceIdentity(temporary),buildId=source.sha256+':production';
  html=`<!doctype html><html><body><div class="editor-app" data-build-id="${buildId}"></div>
    <button>Start editing</button><input type="file" accept=".json"><button>draft</button><button id="export">Export video</button>
    <output id="export-evidence">{"active":false,"phase":"idle"}</output><output id="export-diagnostic-report">{}</output>
    <script>document.querySelector('input').onchange=()=>fetch('/uploaded',{method:'POST'});
    document.querySelector('#export').onclick=()=>document.querySelector('#export-evidence').textContent=JSON.stringify({active:false,phase:'complete',cleanupComplete:true});</script>
    <script src="/assets/index-12345678.js"></script></body></html>`;
  const files=[{path:'index.html',bytes:Buffer.byteLength(html),sha256:sha(html)},
    {path:'assets/index-12345678.js',bytes:Buffer.byteLength(sourceScript),sha256:sha(sourceScript)}];
  await writeFile(path.join(temporary,'dist/index.html'),html);await writeFile(path.join(temporary,'dist/assets/index-12345678.js'),sourceScript);
  await writeFile(path.join(temporary,'reports/build-artifacts.json'),JSON.stringify({schemaVersion:1,buildId,source:{commit:null,dirty:null,inputsSha256:source.sha256},files,
    configuration:{command:'build',mode:'production',automation:false,publicDir:false},outputDir:path.join(temporary,'dist')}));
  const input=path.join(temporary,'reports/input.json');await writeFile(input,'{"mediaAssets":[],"audioTracks":[]}');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.CLIPBRAID_DIAGNOSTIC_TEST_PORT??0),'127.0.0.1',resolve)});
  const url=`http://127.0.0.1:${server.address().port}/`;
  const result=await runCli(temporary,url,input,'reports/run');
  let diagnostic;try{diagnostic=JSON.parse(await readFile(path.join(temporary,'reports/run/result.json'),'utf8'))}catch{}
  const valid=!result.timedOut&&result.exitCode!==0&&uploads===0&&diagnostic?.status==='failed'&&/Served build artifact mismatch/.test(diagnostic.error??'');
  const evidence={schemaVersion:1,status:'failed',scope:'CLI mismatch rejection before upload and a real short production export.',negative:{...result,uploads,diagnostic},positive:null};
  await mkdir('reports',{recursive:true});await writeFile('reports/diagnostic-cli-test.json',JSON.stringify(evidence,null,2)+'\n');
  assert.equal(result.timedOut,false,'Diagnostic CLI must reject the mismatched bundle promptly.');
  assert.notEqual(result.exitCode,0,'A mismatched bundle is not a successful diagnostic run.');
  assert.equal(uploads,0,'Private inputs must not be uploaded before served build verification.');
  assert.equal(valid,true,'CLI must report the exact served-artifact mismatch.');
  console.log('Diagnostic CLI rejected a mismatched served bundle before uploading input.');
  production=await preview({root:process.cwd(),logLevel:'silent',preview:{host:'127.0.0.1',port:0,strictPort:false}});
  const positiveInput=path.join(temporary,'positive-input.json'),positiveFolder=path.join(temporary,'positive-run');
  await writeFile(positiveInput,JSON.stringify(draft([await asset('landscape-red.png',{duration:.25,originalDuration:.25})])));
  const positive=await runCli(process.cwd(),`http://127.0.0.1:${production.httpServer.address().port}/`,positiveInput,positiveFolder,'15000');
  let completed;try{completed=JSON.parse(await readFile(path.join(positiveFolder,'result.json'),'utf8'))}catch{}
  await mkdir('reports/diagnostic-cli-test',{recursive:true});
  const artifactDirectory=await mkdtemp('reports/diagnostic-cli-test/run-');
  try{await cp(positiveFolder,artifactDirectory,{recursive:true})}catch(error){if(error.code!=='ENOENT')throw error}
  await writeFile(path.join(artifactDirectory,'input.json'),await readFile(positiveInput));
  await writeFile(path.join(artifactDirectory,'cli.log'),positive.output);
  evidence.positive={...positive,diagnostic:completed,artifactDirectory};
  evidence.status=!positive.timedOut&&positive.exitCode===0&&completed?.status==='passed'?'passed':'failed';
  await writeFile('reports/diagnostic-cli-test.json',JSON.stringify(evidence,null,2)+'\n');
  const failureSummary=JSON.stringify({exitCode:positive.exitCode,signal:positive.signal,timedOut:positive.timedOut,cli:positive.output.slice(-4000)});
  assert.equal(evidence.status,'passed',`A fresh production build must complete a real diagnostic export. ${failureSummary}`);
  assert.equal(completed.sourceInputsSha256,sourceIdentity().sha256);
  assert.equal(completed.received.bytes,completed.state.result.videoBytes);
  assert.deepEqual(completed.coreAssets.map(file=>file.name).sort(),['ffmpeg-core.js','ffmpeg-core.wasm']);
  console.log('Diagnostic CLI verified the fresh production build and received its checked short MP4.');
}finally{
  if(production)await new Promise(resolve=>production.httpServer.close(resolve));
  await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}
