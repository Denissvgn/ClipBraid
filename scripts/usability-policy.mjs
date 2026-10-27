import {assessSupportMatrix} from './support-policy.mjs';
export const WORKFLOW_STEPS=Object.freeze(['import-visuals','parallel-audio','original-sound','trim-and-order','save-project','reopen-project','export-video','find-saved-video']);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

/** Directional human evidence, never generated participants or emulated users. */
export function assessUsability(study,support,sourceHash) {
  const failures=[],matrix=assessSupportMatrix(support,sourceHash);
  if(!matrix.valid)failures.push('Physical support qualification is incomplete.');
  if(study?.schemaVersion!==1||study.sourceInputsSha256!==sourceHash||study.buildId!==sourceHash+':production'||study.anonymized!==true||!stamp(study.observedAt))
    return {valid:false,participants:0,completed:0,required:4,failures:[...failures,'Study identity or anonymized observation record is incomplete.']};
  const participants=Array.isArray(study.participants)?study.participants:[],seen=new Set(),targets=new Set(matrix.qualifiedTargets.map(target=>target.id));
  const artifacts=new Set((Array.isArray(study.artifacts)?study.artifacts:[]).filter(item=>typeof item?.id==='string').map(item=>item.id));
  let completed=0;
  for(const person of participants) {
    if(!/^P[0-9]{2,3}$/.test(person?.id??'')||seen.has(person?.id)||person?.representative!==true||person.synthetic!==false||!targets.has(person.targetId)||
      !Number.isSafeInteger(person.screenWidth)||person.screenWidth<320||!Number.isSafeInteger(person.screenHeight)||person.screenHeight<320||
      !Array.isArray(person.artifacts)||!person.artifacts.length||person.artifacts.some(item=>typeof item!=='string'||!artifacts.has(item)))failures.push('Participant identities, intended screens or real evidence are incomplete.');
    seen.add(person?.id);
    if(!WORKFLOW_STEPS.every(step=>['passed','failed'].includes(person?.steps?.[step]))||
      !['correct','incorrect'].includes(person?.categoryUnderstanding)||!['correct','incorrect'].includes(person?.saveExportUnderstanding)||
      !['correct','incorrect'].includes(person?.recoveryUnderstanding)||!['correct','incorrect'].includes(person?.progressErrorUnderstanding)||
      !['passed','failed'].includes(person?.keyboardOperation)||!['passed','failed'].includes(person?.legacyOpen)||!['recognized','unrecognized'].includes(person?.legacyProjectRecognition)||typeof person?.coached!=='boolean')
      failures.push('Every participant needs recorded workflow and comprehension observations.');
    if(person?.keyboardOperation!=='passed'||person.legacyOpen!=='passed')failures.push('Final keyboard or legacy-open blocker remains.');
    const confusion=person?.coached===true||WORKFLOW_STEPS.some(step=>person?.steps?.[step]==='failed')||
      ['categoryUnderstanding','saveExportUnderstanding','recoveryUnderstanding','progressErrorUnderstanding'].some(key=>person?.[key]==='incorrect')||person?.legacyProjectRecognition==='unrecognized';
    if(confusion&&!(Array.isArray(study.issues)&&study.issues.some(issue=>Array.isArray(issue?.participantIds)&&issue.participantIds.includes(person.id))))failures.push('Observed confusion needs an issue disposition.');
    if(person?.coached===false&&person.saveExportUnderstanding==='correct'&&WORKFLOW_STEPS.every(step=>person.steps?.[step]==='passed'))completed++;
  }
  const required=Math.ceil(Math.max(5,participants.length)*.8);
  if(participants.length<5||seen.size!==participants.length)failures.push('At least five distinct representative people are required.');
  if(completed<required)failures.push(`Uncoached completion and save/export distinction require ${required} participants.`);
  if(!Array.isArray(study.issues))failures.push('Issue dispositions are missing.');
  else for(const issue of study.issues)if(!Array.isArray(issue?.participantIds)||!issue.participantIds.length||issue.participantIds.some(id=>!seen.has(id))||
    !['critical','minor'].includes(issue?.severity)||!['fixed','accepted-minor'].includes(issue?.disposition)||
    (issue.severity==='critical'&&(issue.disposition!=='fixed'||issue.retestPassed!==true||!artifacts.has(issue.retestArtifactId)))||
    (issue.disposition==='accepted-minor'&&(typeof issue.reason!=='string'||!issue.reason.trim())))failures.push('Unresolved confusion/accessibility/compatibility issue or missing retest.');
  if(!Array.isArray(study.snapshots)||!['mobile','desktop'].every(kind=>study.snapshots.some(item=>item?.kind===kind&&artifacts.has(item.artifactId))))failures.push('Final mobile and desktop snapshots are required.');
  return {valid:failures.length===0,participants:participants.length,completed,required,failures:[...new Set(failures)]};
}
