import {sourceIdentity,repositoryState} from './source-identity.mjs';
import {assessSupportMatrix} from './support-policy.mjs';
import {readEvidence,verifyEvidenceArtifacts,writeAssessment} from './qualification-input.mjs';
const [input,output]=process.argv.slice(2);
if(process.argv.length!==4)throw new Error('Usage: node scripts/check-support.mjs reports/physical-observations.json reports/new-assessment.json');
const source=sourceIdentity(),matrix=await readEvidence(input),assessment=assessSupportMatrix(matrix,source.sha256);
let artifacts=null;
try{if(assessment.valid)artifacts=await verifyEvidenceArtifacts(matrix.artifacts)}catch(error){assessment.valid=false;assessment.failures.push(String(error))}
if(sourceIdentity().sha256!==source.sha256){assessment.valid=false;assessment.failures.push('Source changed during support assessment.')}
const result={schemaVersion:1,status:assessment.valid?'qualified':'blocked',...repositoryState(),sourceInputsSha256:source.sha256,recordedAt:new Date().toISOString(),
  scope:'Operator-supplied physical device/host observations; no synthetic or headless substitution.',...assessment,verifiedArtifacts:artifacts};
await writeAssessment(output,result);process.exitCode=assessment.valid?0:2;
console.log(JSON.stringify({status:result.status,qualifiedTargets:assessment.qualifiedTargets.length,failures:assessment.failures,output}));
