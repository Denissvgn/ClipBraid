import {lstat,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {safeFilePath} from '../mcp-server/storage.js';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function evidencePath(file,root=process.cwd()) {
  root=path.resolve(root);
  const absolute=path.resolve(root,file),relative=path.relative(root,absolute).split(path.sep).join('/');
  if(!relative.startsWith('reports/')||relative.includes('/../'))throw new Error('Qualification records and artifacts must stay in ignored reports/.');
  return safeFilePath(absolute,root);
}
export async function readEvidence(file,root=process.cwd(),maxBytes=4*1048576) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1048576)throw new Error('Invalid qualification read limit.');
  const absolute=await evidencePath(file,root),info=await lstat(absolute);
  if(!info.isFile()||info.size>maxBytes)throw new Error(`Qualification record must be a regular JSON file of at most ${maxBytes} bytes.`);
  return JSON.parse(await readFile(absolute,'utf8'));
}
export async function verifyEvidenceArtifacts(items,root=process.cwd()) {
  if(!Array.isArray(items)||!items.length||items.length>512)throw new Error('Qualification artifacts are missing or exceed 512 files.');
  const names=new Set(),files=new Set();let total=0;
  for(const item of items) {
    if(typeof item?.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)||names.has(item.id)||!hash(item.sha256)||
      !Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>256*1048576)throw new Error('Invalid qualification artifact identity.');
    names.add(item.id);
    const absolute=await evidencePath(item.path,root),info=await lstat(absolute);
    if(files.has(absolute)||!info.isFile()||info.size!==item.bytes)throw new Error('Qualification artifact is duplicate, missing or changed.');
    files.add(absolute);total+=info.size;if(total>2*1024*1048576)throw new Error('Qualification evidence exceeds 2 GiB.');
    const digest=createHash('sha256');for await(const bytes of createReadStream(absolute))digest.update(bytes);
    if(digest.digest('hex')!==item.sha256)throw new Error(`Qualification artifact hash mismatch: ${item.id}`);
  }
  return {files:items.length,bytes:total};
}
export async function writeAssessment(file,value,root=process.cwd()) {
  const absolute=await evidencePath(file,root);
  await mkdir(path.dirname(absolute),{recursive:true,mode:0o700});
  await writeFile(absolute,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
}
