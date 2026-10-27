export const SUPPORT_CASES=Object.freeze(['secure-context','codecs','concurrent-encoders','memory-pressure','orientation','local-import','gallery-import',
  'microphone-allow','microphone-deny','microphone-cancel','project-save-reopen','video-save-accept','video-save-reject','offline','cdn-failure','cancel-retry','local-recovery','legacy-open']);
const requiredKinds=['desktop-chromium','android-flow'];
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=240;
const finite=value=>Number.isFinite(value)&&value>=0;
const id=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const coreCases=new Set(['secure-context','codecs','local-import','project-save-reopen','video-save-accept','cancel-retry','legacy-open']);

/** Assess supplied physical observations; automation never manufactures them. */
export function assessSupportMatrix(matrix,sourceHash) {
  const failures=[],qualified=[];
  if(!/^[a-f0-9]{64}$/.test(sourceHash??'')||matrix?.schemaVersion!==1||matrix.sourceInputsSha256!==sourceHash||matrix.buildId!==sourceHash+':production')
    return {valid:false,qualifiedTargets:[],failures:['Support observations must bind the exact production source/build.']};
  const targets=Array.isArray(matrix.targets)?matrix.targets:[];
  const records=Array.isArray(matrix.artifacts)?matrix.artifacts:[];
  const artifacts=new Set(records.filter(item=>id(item?.id)).map(item=>item.id));
  const seen=new Set();
  for(const target of targets) {
    const errors=[],name=id(target?.id)?target.id:'invalid-target';
    if(!id(target?.id)||seen.has(target?.id)||!requiredKinds.includes(target?.kind))errors.push('unique named target');
    seen.add(target?.id);
    if(target?.physical!==true||target.headless!==false||!id(target.operatorId)||!stamp(target.observedAt))errors.push('physical operator observation');
    const device=target?.device;
    if(!device||!['model','os','browser','browserVersion'].every(key=>text(device[key]))||
      (target?.kind==='android-flow'&&!['webViewVersion','flowVersion'].every(key=>text(device[key]))))errors.push('actual device/runtime versions');
    if(target?.observedBuildId!==matrix.buildId)errors.push('observed page build identity');
    const cases=target?.cases;
    for(const key of SUPPORT_CASES) {
      const value=cases?.[key];
      if(value?.status!=='passed'||!['available','unsupported-with-fallback'].includes(value.behavior)||!text(value.observation)||
        !Array.isArray(value.artifacts)||!value.artifacts.length||value.artifacts.some(reference=>!artifacts.has(reference))||
        (coreCases.has(key)&&value.behavior!=='available'))errors.push(`observed ${key}`);
    }
    const envelope=target?.envelope;
    if(!envelope||!Number.isSafeInteger(envelope.visualClips)||envelope.visualClips<1||!Number.isSafeInteger(envelope.audioTracks)||envelope.audioTracks<1||
      !finite(envelope.durationSeconds)||envelope.durationSeconds<=0||!Number.isSafeInteger(envelope.inputBytes)||envelope.inputBytes<=0||
      !Array.isArray(envelope.profiles)||!envelope.profiles.length||envelope.profiles.some(profile=>!['draft','standard'].includes(profile)))errors.push('measured project/profile envelope');
    const reduced=!envelope||envelope.visualClips<23||envelope.durationSeconds<181.02-1e-6||!['draft','standard'].every(profile=>envelope.profiles?.includes(profile));
    if(reduced&&(!id(target?.scopeDecision?.approvedBy)||!stamp(target.scopeDecision.recordedAt)||!text(target.scopeDecision.reason)))errors.push('explicit reduced-envelope scope decision');
    const measured=target?.measurements;
    if(!measured||!Number.isSafeInteger(measured.concurrentEncoders)||measured.concurrentEncoders<1||measured.concurrentEncoders>2||
      !finite(measured.cancelAckMs)||measured.cancelAckMs>250||!finite(measured.cleanupMs)||measured.cleanupMs>5000||!finite(measured.steadyAvSkewMs)||measured.steadyAvSkewMs>80||
      !text(measured.memoryScope)||(measured.peakMemoryBytes!==null&&(!Number.isSafeInteger(measured.peakMemoryBytes)||measured.peakMemoryBytes<=0)))errors.push('measured timing/resource limits');
    if(errors.length)failures.push(`${name}: missing/failed ${[...new Set(errors)].join(', ')}.`);
    else {
      const pick=(object,keys)=>Object.fromEntries(keys.filter(key=>object[key]!==undefined).map(key=>[key,object[key]]));
      qualified.push({id:target.id,kind:target.kind,device:pick(target.device,['model','os','browser','browserVersion','webViewVersion','flowVersion']),
        envelope:pick(target.envelope,['visualClips','audioTracks','durationSeconds','inputBytes','profiles']),
        measurements:pick(target.measurements,['concurrentEncoders','cancelAckMs','cleanupMs','steadyAvSkewMs','memoryScope','peakMemoryBytes']),
        limitations:SUPPORT_CASES.filter(key=>cases[key].behavior==='unsupported-with-fallback')});
    }
  }
  for(const kind of requiredKinds)if(!qualified.some(target=>target.kind===kind))failures.push(`No qualified physical ${kind} target.`);
  return {valid:failures.length===0,qualifiedTargets:qualified,failures};
}
