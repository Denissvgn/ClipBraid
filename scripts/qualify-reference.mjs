// Opt-in local reference qualification. Never imported by production or npm check.
// Requires Python 3/NumPy and native FFmpeg/ffprobe; media/evidence remains ignored.
import {readFile,writeFile,mkdir,cp,stat,readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {preview} from 'vite';
import {diagnosticOptions,digest} from './diagnostic-policy.mjs';
import {diagnosticBuild} from './diagnostic-policy.mjs';
import {createQualificationRun} from './qualification-evidence.mjs';
import {repositoryState,sourceIdentity} from './source-identity.mjs';
import {assessReferenceRuns} from './reference-policy.mjs';

const [input,folder]=process.argv.slice(2);
if(process.argv.length!==4)throw new Error('Usage: node scripts/qualify-reference.mjs private-reference.json reports/new-reference-directory');
const options=diagnosticOptions([input,folder]);
const inputStat=await stat(options.input);
if(!inputStat.isFile()||inputStat.size>256*1048576)throw new Error('Reference input must be a regular project file of at most 256 MiB.');
await mkdir(options.folder,{recursive:true});
const manifestFile=path.join(options.folder,'reference.json');
await writeFile(manifestFile,'{}',{flag:'wx',mode:0o600});
const build=diagnosticBuild(),owner=await createQualificationRun();
const manifest={schemaVersion:1,status:'running',runId:randomUUID(),...repositoryState(),sourceInputsSha256:build.identity.sha256,
  sourceInputs:build.identity.inputs,
  startedAt:new Date().toISOString(),scope:'23-clip local software Chromium reference; physical targets, human listening and release remain separate.',runs:[],failures:[]};
let server,child,interrupted=false;
const save=()=>writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
const stop=signal=>{try{if(child?.pid){if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal)}}catch{}};
async function inventory(directory,relative='') {
  const files=[];
  for(const name of await readdir(directory)) {
    if(!relative&&name==='reference.json')continue;
    const file=path.join(directory,name),entry=relative?`${relative}/${name}`:name,info=await lstat(file);
    if(info.isSymbolicLink())throw new Error('Reference evidence contains a symlink.');
    if(info.isDirectory())files.push(...await inventory(file,entry));
    else if(info.isFile()){
      const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);
      files.push({path:entry,bytes:info.size,sha256:hash.digest('hex')});
    }else throw new Error('Reference evidence must contain regular files.');
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;stop('SIGTERM');setTimeout(()=>stop('SIGKILL'),3000).unref()});
async function run(command,args,log,timeout,env={}) {
  const chunks=[];let bytes=0;
  const result=await new Promise(resolve=>{
    child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env:{...process.env,...env},detached:process.platform!=='win32'});
    const record=data=>{bytes+=data.length;if(bytes<=1024*1024)chunks.push(data)};
    child.stdout.on('data',record);child.stderr.on('data',record);
    let timedOut=false,error,hardStop;
    const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');hardStop=setTimeout(()=>stop('SIGKILL'),3000)},timeout);
    child.on('error',value=>{error=String(value)});
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(hardStop);child=null;resolve({exitCode,signal,timedOut,error})});
  });
  await writeFile(log,Buffer.concat(chunks),{flag:'wx',mode:0o600});
  if(interrupted||result.exitCode!==0||result.signal||result.timedOut||result.error)throw new Error(`${command} failed: ${JSON.stringify(result)}; see ${log}`);
}
try {
  const bytes=await readFile(options.input),project=JSON.parse(bytes);
  if(project.mediaAssets?.length!==23||project.mediaAssets.some(clip=>clip.type!=='video'||!clip.muted))throw new Error('Expected the muted legacy 23-clip reference.');
  const original=path.join(options.folder,'original.json'),native=path.join(options.folder,'native-audio.json');
  await writeFile(original,bytes,{flag:'wx',mode:0o600});
  const variant={...project,mediaAssets:project.mediaAssets.map(clip=>({...clip,muted:false}))};
  await writeFile(native,JSON.stringify(variant),{flag:'wx',mode:0o600});
  manifest.inputSha256=digest(bytes);
  manifest.build=build.build;
  await cp('dist',path.join(options.folder,'dist'),{recursive:true,errorOnExist:true,force:false});
  server=await preview({root:process.cwd(),logLevel:'silent',preview:{host:'127.0.0.1',port:0,strictPort:false}});
  const url=`http://127.0.0.1:${server.httpServer.address().port}/`;
  for(const [name,quality,variantName,source] of [['draft-1','draft','original',original],['standard-1','standard','original',original],['draft-2','draft','original',original],['draft-native','draft','native-audio',native]]) {
    if(interrupted||sourceIdentity().sha256!==build.identity.sha256)throw new Error('Reference source changed or run interrupted.');
    const directory=path.join(options.folder,name),entry={name,quality,variant:variantName,directory};
    manifest.runs.push(entry);await save();console.log(`Reference: ${name}`);
    await run(process.execPath,['scripts/diagnose-export.mjs',source,directory,quality,'auto','420000'],path.join(options.folder,name+'.log'),480000,
      {CLIPBRAID_DIAGNOSTIC_URL:url,CLIPBRAID_DIAGNOSTIC_SOFTWARE:'1'});
    entry.result=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
    await run('python3',['scripts/inspect-reference.py',source,directory],path.join(options.folder,name+'-inspection.log'),300000);
    entry.inspection=JSON.parse(await readFile(path.join(directory,'inspection.json'),'utf8'));
    const trace=JSON.parse(await readFile(path.join(directory,'trace.json'),'utf8'));
    entry.resources={pageJsHeapPeakBytes:Math.max(0,...trace.map(point=>point.resources?.pageJsHeapBytes??0)),scope:'Sampled page JavaScript heap only; workers, native decoders and total browser RSS unmeasured'};
    await save();
  }
  const assessment=assessReferenceRuns(manifest.runs,build.identity.sha256);
  manifest.failures=assessment.failures;
  manifest.status=assessment.valid?'passed':'failed';
  if(sourceIdentity().sha256!==build.identity.sha256)throw new Error('Source changed during final inspection.');
}catch(error){manifest.status='failed';manifest.failures.push(String(error));process.exitCode=1}
finally {
  if(server)await new Promise(resolve=>server.httpServer.close(resolve));
  try{manifest.artifacts=await inventory(options.folder)}catch(error){manifest.status='failed';manifest.failures.push(String(error));process.exitCode=1}
  try{await owner.release()}catch(error){manifest.status='failed';manifest.failures.push(String(error));process.exitCode=1}
  manifest.endedAt=new Date().toISOString();await save();
}
if(manifest.status!=='passed')process.exitCode=1;
console.log(JSON.stringify({status:manifest.status,runs:manifest.runs.map(run=>({name:run.name,status:run.inspection?.status,wallMs:run.result?.wallMs})),failures:manifest.failures,manifest:manifestFile}));
