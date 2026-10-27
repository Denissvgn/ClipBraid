import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { sourceIdentity, repositoryState } from './source-identity.mjs';
import { assessPlaywright } from './qualification-policy.mjs';
import { createQualificationRun, archiveQualification } from './qualification-evidence.mjs';

// One gate at a time, with private evidence even when a child fails or times out.
const gates = [['check:toolchain',30000], ['typecheck',60000], ['check:mcp',60000], ['test:unit',120000],
  ['build',120000], ['check:build-isolation',120000], ['check:style-isolation',120000], ['check:artifacts',30000], ['test:diagnostic',60000], ['test:browser',1150000], ['test:production',120000]];
const directory = 'reports/qualification';
const reportFiles=['reports/toolchain.json','reports/build-artifacts.json','reports/build-isolation.json','reports/style-isolation.json','reports/diagnostic-cli-test.json','reports/browser-manifest.json','reports/browser-results.json','reports/production-results.json'];
async function qualify(){
const initial = sourceIdentity(), sha = value => createHash('sha256').update(value).digest('hex');
const owner=await createQualificationRun();
let manifest;
const save = () => {
  const bytes=JSON.stringify(manifest,null,2)+'\n';
  for(const target of [directory,owner.absoluteArchive]){
    const temporary=`${target}/candidate.${owner.runId}.tmp`;
    writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});renameSync(temporary,`${target}/candidate.json`);
  }
};
try{
mkdirSync(directory,{recursive:true});
for(const file of reportFiles)rmSync(file,{force:true}); // A stopped gate must not inherit a previous run's evidence.
manifest = {schemaVersion:1,status:'running',startedAt:new Date().toISOString(),
  runId:owner.runId,archiveDirectory:owner.archiveDirectory,
  previousCandidateScope:'The previous-candidate.json snapshot, if present, preserves only its original record; old canonical artifacts may have changed.',
  source:{...repositoryState(),inputsSha256:initial.sha256},
  sourceInputs:initial.inputs,lockfileSha256:sha(readFileSync('package-lock.json')),
  environment:{node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),os:`${os.platform()} ${os.release()} ${os.arch()}`},
  scope:'Automated bounded synthetic media and recovery on standalone pinned Chromium. Full-reference visual/listening, physical device/Flow, user validation and release rollout remain separate.',
  steps:[],counts:{},artifacts:[]};
save();
let child, currentStep, interrupted = false;
const stop = signal => {
  try {if(child?.pid){if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal)}} catch {}
};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  interrupted=true;manifest.status='failed';manifest.error='Qualification interrupted.';process.exitCode=1;
  try{save()}catch{}stop('SIGTERM');setTimeout(()=>stop('SIGKILL'),3000).unref();
});
async function run(name, timeout) {
  return new Promise(resolve=>{
    const started=performance.now();let timer,hardStop,tail='',timedOut=false;
    child=spawn('npm',['run',name],{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',env:process.env});
    const output=chunk=>{const text=chunk.toString();process.stdout.write(text);tail=(tail+text).slice(-2*1024*1024)};
    child.stdout.on('data',output);child.stderr.on('data',output);
    timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');hardStop=setTimeout(()=>stop('SIGKILL'),3000)},timeout);
    child.on('error',error=>output(Buffer.from(String(error))));
    child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(hardStop);child=null;resolve({exitCode:timedOut?1:code??1,signal,timedOut,elapsedMs:Math.round(performance.now()-started),output:tail})});
  });
}
try {
  for(const [name,timeout] of gates) {
    if(interrupted)throw new Error('Qualification interrupted.');
    if(sourceIdentity().sha256!==initial.sha256)throw new Error('Source inputs changed during qualification; start a fresh run.');
    const log=`${directory}/${name.replaceAll(':','-')}.log`,step={name,status:'running',startedAt:new Date().toISOString(),budgetMs:timeout,log};
    manifest.steps.push(step);save();
    currentStep=step;
    const result=await run(name,timeout),temporary=`${log}.${owner.runId}.tmp`;
    writeFileSync(temporary,result.output,{flag:'wx',mode:0o600});renameSync(temporary,log);
    Object.assign(step,{status:result.exitCode===0?'passed':'failed',exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,elapsedMs:result.elapsedMs,endedAt:new Date().toISOString()});
    save();
    if(result.exitCode!==0)throw new Error(`${name} failed; see ${log}.`);
    if(name==='test:unit') {
      const count=key=>Number([...result.output.matchAll(new RegExp(`^# ${key} (\\d+)$`,'gm'))].at(-1)?.[1]??NaN);
      const counts={total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')};
      const explainedSkip=counts.skipped===1&&!existsSync('test-data/reference-project.json')&&result.output.includes('SKIP local reference draft is absent from this checkout');
      if(!Object.values(counts).every(value=>Number.isSafeInteger(value)&&value>=0)||!counts.total||counts.failed||counts.cancelled||(counts.skipped&&!explainedSkip)||counts.passed+counts.skipped!==counts.total)
        throw new Error('Unit results are incomplete or contain unexplained skips.');
      manifest.counts.unit={...counts,explainedOptionalSkips:explainedSkip?['Private reference absent; synthetic legacy migration remains required.']:[]};
    }
    if(name==='test:browser'||name==='test:production') {
      const production=name==='test:production',report=JSON.parse(readFileSync(`reports/${production?'production':'browser'}-results.json`,'utf8'));
      const assessed=assessPlaywright(report,!production,production?'production':'');
      if(!assessed.valid)throw new Error(`${name} contains global errors, missing required coverage, skipped, failed or expected-failure cases.`);
      manifest.counts[production?'production':'browser']={total:assessed.total,passed:assessed.passed,skipped:assessed.skipped};
      if(!production) {
        const browser=JSON.parse(readFileSync('reports/browser-manifest.json','utf8'));
        if(browser.result!=='passed'||browser.source.inputsSha256!==initial.sha256)throw new Error('Browser evidence belongs to a different or failed source candidate.');
      }
    }
    save();
    currentStep=null;
  }
  if(interrupted)throw new Error('Qualification interrupted.');
  if(sourceIdentity().sha256!==initial.sha256)throw new Error('Source inputs changed during the final gate.');
  const build=JSON.parse(readFileSync('reports/build-artifacts.json','utf8'));
  if(build.source.inputsSha256!==initial.sha256||build.source.commit!==manifest.source.commit)throw new Error('Build evidence belongs to another candidate.');
  manifest.buildId=build.buildId;manifest.status='passed';
} catch(error) {manifest.status='failed';manifest.error=String(error);if(currentStep){currentStep.status='failed';currentStep.error=String(error)}process.exitCode=1;process.stderr.write(`${error}\n`)}
finally {
  try{
    const archived=await archiveQualification(manifest,owner.archiveDirectory,reportFiles);
    manifest.artifacts=archived.artifacts;manifest.archiveNotes=archived.notes;
  }catch(error){manifest.status='failed';manifest.error=`Qualification evidence could not be preserved: ${String(error)}`;process.exitCode=1;process.stderr.write(manifest.error+'\n')}
  manifest.endedAt=new Date().toISOString();save();
}
}finally{
  try{await owner.release()}catch(error){
    process.exitCode=1;
    if(manifest){manifest.status='failed';manifest.error=`Qualification lock cleanup failed: ${String(error)}`;save()}
    process.stderr.write(`Qualification lock cleanup failed: ${String(error)}\n`);
  }
}
process.stdout.write(`Candidate qualification: ${manifest.status}; ${directory}/candidate.json\n`);
}
await qualify();
