import { mkdir, readFile, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { safeFilePath, readBounded, MAX_JOURNAL_BYTES } from '../mcp-server/storage.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowed=file=>typeof file==='string'&&!path.isAbsolute(file)&&!file.includes('\\')&&path.posix.normalize(file)===file&&
  (file.startsWith('reports/')||file.startsWith('test-results/')||file.startsWith('dist/'));

/** One owner per checkout; completed run directories are never reused. */
export async function createQualificationRun(root=process.cwd()) {
  root=path.resolve(root);const runId=randomUUID(),archiveDirectory=`reports/qualification-runs/${runId}`;
  const owner=await safeFilePath(path.join(root,'reports/qualification.lock/owner.json'),root),lock=path.dirname(owner);
  await mkdir(path.dirname(lock),{recursive:true,mode:0o700});
  try{await mkdir(lock,{mode:0o700})}catch(error){if(error.code==='EEXIST')throw new Error('Qualification is already running or its abandoned lock needs manual recovery.');throw error}
  try{
    await writeFile(owner,JSON.stringify({runId,pid:process.pid}),{flag:'wx',mode:0o600});
    const destination=await safeFilePath(path.join(root,archiveDirectory,'candidate.json'),root);
    await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    const canonical=await safeFilePath(path.join(root,'reports/qualification/candidate.json'),root);
    await mkdir(path.dirname(canonical),{recursive:true,mode:0o700});
    const previous=await readBounded(canonical,MAX_JOURNAL_BYTES,false,root);
    if(previous.mtimeMs!==null)await writeFile(path.join(path.dirname(destination),'previous-candidate.json'),previous.text,{flag:'wx',mode:0o600});
    return {runId,archiveDirectory,absoluteArchive:path.dirname(destination),async release(){
      const value=JSON.parse(await readFile(owner,'utf8'));
      if(value.runId!==runId)throw new Error('Qualification lock ownership changed.');
      await rm(lock,{recursive:true});
    }};
  }catch(error){await rm(lock,{recursive:true,force:true});throw error}
}

/** Preserve exact owned output bytes, never another run's canonical filenames. */
export async function archiveQualification(manifest,archiveDirectory,reportFiles,root=process.cwd()) {
  root=path.resolve(root);const files=new Map(),notes=[];
  const add=(file,expected)=>{
    if(!allowed(file))throw new Error('Unapproved qualification evidence path.');
    files.set(file,expected??files.get(file));
  };
  for(const file of reportFiles)add(file);
  for(const step of manifest.steps??[])add(step.log);
  const bytesFor=async file=>{
    const source=await safeFilePath(path.join(root,file),root),stat=await lstat(source);
    if(!stat.isFile()||stat.size>128*1048576)throw new Error('Qualification evidence must be regular files of at most 128 MiB.');
    return readFile(source);
  };
  const json=async file=>{try{return JSON.parse((await bytesFor(file)).toString('utf8'))}catch(error){if(error.code==='ENOENT')return null;if(manifest.status==='passed')throw error;notes.push(`${file}: ${String(error)}`);return null}};
  const walk=async directory=>{
    await safeFilePath(path.join(root,directory,'.probe'),root);
    let entries;try{entries=await readdir(path.join(root,directory),{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error}
    for(const entry of entries){const file=`${directory}/${entry.name}`;if(entry.isDirectory())await walk(file);else add(file)}
  };
  const browser=await json('reports/browser-manifest.json');
  if(browser){
    for(const item of browser.artifacts??[]){
      if(item.path!=='reports/browser-results.json'&&!item.path.startsWith('test-results/'))throw new Error('Unapproved browser evidence path.');
      add(item.path,item.sha256);
    }
    if(manifest.status==='passed'&&(!browser.jobs?.length||!browser.jobs.every(job=>(browser.artifacts??[]).some(item=>item.path.startsWith('test-results/')&&item.sha256===job.sha256&&item.bytes===job.bytes))))
      throw new Error('Received smoke output is missing from qualification evidence.');
  }
  const build=await json('reports/build-artifacts.json');
  if(build)for(const item of build.files??[])add(`dist/${item.path}`,item.sha256);
  if(await json('reports/production-results.json'))await walk('test-results/production');
  const diagnostic=await json('reports/diagnostic-cli-test.json');
  if(diagnostic?.positive?.artifactDirectory){
    const directory=diagnostic.positive.artifactDirectory;
    if(!directory.startsWith('reports/diagnostic-cli-test/')||!allowed(directory))throw new Error('Unapproved diagnostic evidence directory.');
    await walk(directory);
  }
  let total=0;const artifacts=[];
  for(const [file,expected] of files){
    let bytes;try{bytes=await bytesFor(file)}catch(error){if(error.code==='ENOENT'&&(!expected||manifest.status!=='passed')){notes.push(`Missing: ${file}`);continue}throw error}
    const digest=sha(bytes);
    if(expected&&digest!==expected){if(manifest.status==='passed')throw new Error(`Qualification evidence changed: ${file}`);notes.push(`Expected hash differs: ${file}`)}
    total+=bytes.length;if(total>256*1048576)throw new Error('Fast qualification evidence exceeds 256 MiB; keep larger diagnostics separate.');
    const archivePath=`${archiveDirectory}/${file}`,destination=await safeFilePath(path.join(root,archivePath),root);
    await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,bytes,{flag:'wx',mode:0o600});
    artifacts.push({path:file,bytes:bytes.length,sha256:digest,archivePath});
  }
  return {artifacts,notes};
}
