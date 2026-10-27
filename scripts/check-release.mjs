import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {sourceIdentity,repositoryState} from './source-identity.mjs';
import {assessRelease} from './release-policy.mjs';
import {assessPlaywright} from './qualification-policy.mjs';
import {safeFilePath} from '../mcp-server/storage.js';
import {readEvidence,verifyEvidenceArtifacts,writeAssessment} from './qualification-input.mjs';
const [configFile,output]=process.argv.slice(2);
if(process.argv.length!==4)throw new Error('Usage: node scripts/check-release.mjs reports/release-inputs.json reports/new-release-assessment.json');
const root=process.cwd(),source=sourceIdentity(),config=await readEvidence(configFile),candidateRoot=path.resolve(config.candidateRoot??root);
const inside=(base,file)=>{const relative=path.relative(base,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))};
if(!inside(root,candidateRoot)&&!inside(path.resolve(tmpdir()),candidateRoot))throw new Error('Clean candidate must stay in this checkout or the system temporary directory.');
const candidate=await readEvidence(config.candidate,candidateRoot),reference=await readEvidence(config.reference),support=await readEvidence(config.support),study=await readEvidence(config.study);
const backlogPath=await safeFilePath(path.resolve(root,config.backlog),root),backlogInfo=await lstat(backlogPath);
if(!backlogInfo.isFile()||backlogInfo.size>1048576)throw new Error('Backlog must be a regular file of at most 1 MiB.');
const backlog=await readFile(backlogPath,'utf8');
const lockfileSha256=createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
const assessment=assessRelease({candidate,reference,support,study,backlog,source,lockfileSha256}),verified={};
try {
  if(sourceIdentity(candidateRoot).sha256!==source.sha256)throw new Error('Clean checkout and current source differ.');
  if(!assessPlaywright(await readEvidence('reports/browser-results.json',candidateRoot,64*1048576),true).valid||
    !assessPlaywright(await readEvidence('reports/production-results.json',candidateRoot,64*1048576),false,'production').valid)throw new Error('Required browser/production coverage is incomplete.');
  verified.candidate=await verifyEvidenceArtifacts(candidate.artifacts.map((item,index)=>({...item,id:`candidate-${index}`,path:item.archivePath??item.path})),candidateRoot);
  const referenceBase=path.posix.dirname(config.reference);
  verified.reference=await verifyEvidenceArtifacts(reference.artifacts.map((item,index)=>({...item,id:`reference-${index}`,path:path.posix.join(referenceBase,item.path)})));
  if(assessment.physical.valid)verified.physical=await verifyEvidenceArtifacts(support.artifacts);
  if(assessment.usability.valid)verified.usability=await verifyEvidenceArtifacts(study.artifacts);
}catch(error){assessment.valid=false;assessment.failures.push(String(error))}
if(sourceIdentity().sha256!==source.sha256){assessment.valid=false;assessment.failures.push('Source changed during handoff verification.')}
const result={schemaVersion:1,status:assessment.valid?'qualified':'blocked',...repositoryState(),sourceInputsSha256:source.sha256,sourceInputs:source.inputs,
  lockfileSha256,recordedAt:new Date().toISOString(),...assessment,verifiedArtifacts:verified,
  publication:'No deployment, tag, release, origin change or announcement performed or authorized by this assessment.'};
await writeAssessment(output,result);process.exitCode=result.valid?0:2;
console.log(JSON.stringify({status:result.status,failures:result.failures,openCards:result.closure.openCards,referenceChanges:result.referenceChanges,output}));
