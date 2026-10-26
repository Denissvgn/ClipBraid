import { readFileSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sourceIdentity } from './source-identity.mjs';
import { assertProductArtifact } from './artifact-policy.mjs';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(base,file)=>{const relative=path.relative(base,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))};
export function diagnosticOptions(args,environment=process.env,root=process.cwd()) {
  const [input,folder,quality='draft',plan='auto',rawTimeout='420000']=args;
  if(!input||!folder||args.length>5)throw new Error('Usage: diagnose-export.mjs input.json ignored-output-dir [quality] [auto|single] [timeout-ms]');
  if(!['draft','standard','high'].includes(quality)||!['auto','single'].includes(plan))throw new Error('Invalid diagnostic quality or encoder plan.');
  const timeoutMs=Number(rawTimeout);
  if(!/^\d+$/.test(rawTimeout)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw new Error('Diagnostic timeout must be 1000–1800000 ms.');
  const baseURL=new URL(environment.CLIPBRAID_DIAGNOSTIC_URL??'http://127.0.0.1:4181/');
  if(!['http:','https:'].includes(baseURL.protocol)||!['localhost','127.0.0.1','[::1]'].includes(baseURL.hostname)||baseURL.username||baseURL.password||baseURL.search||baseURL.hash)
    throw new Error('Diagnostic URL must be a local loopback HTTP(S) server.');
  if(!baseURL.pathname.endsWith('/'))baseURL.pathname+='/';
  root=path.resolve(root);const output=path.resolve(root,folder),reports=path.join(root,'reports');
  const base=inside(root,output)?reports:path.resolve(tmpdir());
  if(!inside(base,output))throw new Error('Diagnostic evidence must stay in reports/ or outside the checkout in the system temporary directory.');
  if(inside(root,output)&&existsSync(path.join(root,'.git'))){
    const ignored=spawnSync('git',['check-ignore','--no-index','--quiet',path.relative(root,path.join(output,'result.json'))],{cwd:root,timeout:5000,stdio:'ignore'});
    if(ignored.status!==0)throw new Error('Diagnostic evidence must be ignored by Git.');
  }
  let current=base;
  for(const part of ['',...path.relative(base,output).split(path.sep).filter(Boolean)]){
    current=path.join(current,part);
    try{const value=lstatSync(current);if(value.isSymbolicLink()||!value.isDirectory())throw new Error('Diagnostic evidence directories must not contain symlinks or files.');}
    catch(error){if(error.code!=='ENOENT')throw error}
  }
  for(const name of ['result.json','trace.json','trace.jsonl','output.mp4'])if(existsSync(path.join(output,name)))throw new Error('Diagnostic evidence already exists; choose a new output directory.');
  return {input:path.resolve(root,input),folder:output,quality,plan,timeoutMs,baseURL:baseURL.href};
}
export function diagnosticBuild(root=process.cwd()) {
  const identity=sourceIdentity(root),build=JSON.parse(readFileSync(path.join(root,'reports/build-artifacts.json'),'utf8'));
  if(build.source?.inputsSha256!==identity.sha256||build.buildId!==identity.sha256+':production'||build.configuration?.command!=='build'||
    build.configuration?.mode!=='production'||build.configuration?.automation!==false||build.configuration?.publicDir!==false)
    throw new Error('Build evidence does not match this production source. Build the current source before diagnosis.');
  if(!Array.isArray(build.files)||!build.files.some(file=>file.path==='index.html')||!build.files.some(file=>/^assets\/index-[a-zA-Z0-9_-]+\.js$/.test(file.path)))throw new Error('Production build artifact inventory is missing.');
  const paths=new Set();
  for(const file of build.files)if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').includes('..')||
    !Number.isSafeInteger(file.bytes)||file.bytes<1||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid build artifact inventory.');
  for(const file of build.files){assertProductArtifact(file.path,new Uint8Array());if(paths.has(file.path))throw new Error('Duplicate build artifact.');paths.add(file.path)}
  return {identity,build};
}
export async function verifyDiagnosticServer(request,baseURL,build) {
  const verified=[],expires=performance.now()+30000;
  for(const file of build.files){
    const remaining=expires-performance.now();if(remaining<=0)throw new Error('Served build verification timed out.');
    const response=await request.get(new URL(file.path,baseURL).href,{timeout:Math.min(10000,Math.ceil(remaining)),maxRedirects:0});
    const bytes=await response.body();
    if(response.status()!==200||bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw new Error(`Served build artifact mismatch: ${file.path}`);
    verified.push({...file,url:new URL(file.path,baseURL).href});
  }
  return verified;
}
export function diagnosticComplete(state,received,buildId) {
  return !!state&&state.phase==='complete'&&!state.active&&state.cleanupComplete===true&&state.buildId===buildId&&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(state.jobId??'')&&
    state.result?.delivery==='download-started'&&received?.failure===null&&Number.isSafeInteger(received?.bytes)&&received.bytes>0&&
    received.bytes===state.result.videoBytes&&/^[a-f0-9]{64}$/.test(received.sha256??'')&&
    /^[a-f0-9]{64}$/.test(state.input?.fingerprint??'')&&state.events?.every(event=>event.jobId===state.jobId&&event.buildId===buildId)&&
    ['verified','download-started'].every(type=>state.events?.some(event=>event.type===type&&event.jobId===state.jobId&&event.buildId===buildId));
}
export function observerStopped(report) {
  if(report?.outcome!=='running')return report;
  const delivery=report.events?.some(event=>event.type==='delivery-started'),receipt=report.events?.some(event=>['download-started','host-accepted','cancelled'].includes(event.type));
  return {...report,outcome:'unknown',cleanupComplete:false,warnings:[...new Set([...(report.warnings??[]),'previous-session-unobserved',...(delivery&&!receipt?['delivery-uncertain']:[])])]};
}
