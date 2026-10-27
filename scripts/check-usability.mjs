import {sourceIdentity,repositoryState} from './source-identity.mjs';
import {assessUsability} from './usability-policy.mjs';
import {readEvidence,verifyEvidenceArtifacts,writeAssessment} from './qualification-input.mjs';
const [studyFile,supportFile,output]=process.argv.slice(2);
if(process.argv.length!==5)throw new Error('Usage: node scripts/check-usability.mjs reports/study.json reports/physical-observations.json reports/new-study-assessment.json');
const source=sourceIdentity(),study=await readEvidence(studyFile),support=await readEvidence(supportFile),assessment=assessUsability(study,support,source.sha256);
let artifacts=null;
try{if(assessment.valid){await verifyEvidenceArtifacts(support.artifacts);artifacts=await verifyEvidenceArtifacts(study.artifacts)}}catch(error){assessment.valid=false;assessment.failures.push(String(error))}
if(sourceIdentity().sha256!==source.sha256){assessment.valid=false;assessment.failures.push('Source changed during study assessment.')}
const result={schemaVersion:1,status:assessment.valid?'qualified':'blocked',...repositoryState(),sourceInputsSha256:source.sha256,recordedAt:new Date().toISOString(),
  scope:'Five or more actual representative users; directional workflow evidence only.',...assessment,verifiedArtifacts:artifacts};
await writeAssessment(output,result);process.exitCode=assessment.valid?0:2;console.log(JSON.stringify(result));
