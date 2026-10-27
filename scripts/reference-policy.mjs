import {diagnosticComplete} from './diagnostic-policy.mjs';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Full-reference measurements qualify only this named local software target. */
export function assessReferenceRuns(runs,sourceHash) {
  const failures=[];
  if(!hash(sourceHash)||!Array.isArray(runs)||runs.length!==4||runs.some(run=>!run||typeof run!=='object'))return {valid:false,failures:['Four exact-source full-reference runs are required.']};
  const originals=runs.filter(run=>run.variant==='original');
  if(originals.length!==3||originals.filter(run=>run.result?.quality==='draft').length!==2||originals.filter(run=>run.result?.quality==='standard').length!==1)
    failures.push('Original Draft, Standard and repeated Draft are required.');
  const native=runs.filter(run=>run.variant==='native-audio');
  if(native.length!==1||native[0].inspection?.audio?.unmutedClips!==23)failures.push('The unmuted 23-clip variant is required.');
  const inputHashes=new Set(originals.map(run=>run.result?.inputSha256));
  if(inputHashes.size!==1||![...inputHashes].every(hash))failures.push('Repeatability must use identical original input bytes.');
  if(originals.some(run=>run.inspection?.audio?.unmutedClips!==0))failures.push('Original-reference runs must retain the muted clip-audio settings.');
  if(native.length&&inputHashes.has(native[0].result?.inputSha256))failures.push('Native-audio variant must be distinct from the muted original.');
  const jobs=new Set();
  for(const run of runs) {
    const result=run.result,inspection=run.inspection;
    if(result?.status!=='passed'||result.sourceInputsSha256!==sourceHash||result.buildId!==sourceHash+':production'||!Array.isArray(result.errors)||result.errors.length||!Array.isArray(result.integrityErrors)||result.integrityErrors.length||result.deadlineReached||
      !diagnosticComplete(result.state,result.received,result.buildId))failures.push('A full-reference export lacks valid exact-source delivery evidence.');
    if(!result?.environment?.launchArgs?.includes('--disable-accelerated-video-encode')||!result.environment.launchArgs.includes('--disable-gpu'))failures.push('Named software Chromium configuration is missing.');
    if(jobs.has(result?.state?.jobId))failures.push('Runs must have independent job identities.');
    jobs.add(result?.state?.jobId);
    if(inspection?.status!=='passed'||inspection.sourceInputsSha256!==sourceHash||inspection.inputSha256!==result?.inputSha256||inspection.receivedSha256!==result?.received?.sha256||
      inspection.clipCount!==23||inspection.pictures?.length<90||inspection.audio?.comparisons?.length<25)failures.push('Full decode and complete selected picture/audio inspection are required.');
    if(!Number.isFinite(inspection?.profile?.fps)||inspection.profile.fps<=0||inspection.profile.fps>30||
      !Array.isArray(inspection?.pictures)||!inspection.pictures.every(point=>point&&Number.isFinite(point.psnrDb)&&point.psnrDb>=24)||
      !Array.isArray(inspection?.audio?.comparisons)||!inspection.audio.comparisons.every(point=>point&&(point.kind==='near-silence'?Number.isFinite(point.rms)&&point.rms>=0&&point.rms<=.001:
        point.kind==='content'&&Number.isFinite(point.correlation)&&point.correlation>=.85&&Number.isFinite(point.levelRatio)&&point.levelRatio>=.8&&point.levelRatio<=1.2&&Number.isFinite(point.offsetMs)&&Math.abs(point.offsetMs)<=1000/inspection.profile.fps)))
      failures.push('Picture/audio measurements do not meet the fixed reference thresholds.');
    const dimensions=result?.quality==='standard'?[1280,720]:[854,480];
    if(inspection?.profile?.width!==dimensions[0]||inspection?.profile?.height!==dimensions[1])failures.push('Reference profile dimensions are inconsistent.');
    const pictures=Array.isArray(inspection?.pictures)?inspection.pictures:[],frames=new Set(pictures.map(point=>point?.frame)),total=inspection?.profile?.frames;
    const covered=new Set(pictures.flatMap(point=>Array.isArray(point?.activeClips)?point.activeClips:[]));
    if(!Number.isSafeInteger(total)||total<3||frames.size!==pictures.length||pictures.some(point=>!Number.isSafeInteger(point?.frame)||point.frame<0||point.frame>=total)||
      ![0,total-1,Math.floor(total/2)-1,Math.floor(total/2),Math.floor(total/2)+1].every(frame=>frames.has(frame))||
      !Array.from({length:23},(_,index)=>index).every(index=>covered.has(index)))failures.push('Distinct frame coverage must include every clip, both ends and the encoder seam.');
    const audio=inspection?.audio?.comparisons;
    if(!Array.isArray(audio)||audio.some(point=>!Number.isFinite(point?.time)||point.time<0)||new Set(audio.map(point=>point?.time)).size!==audio.length)failures.push('Audio observation windows must be distinct and finite.');
  }
  return {valid:failures.length===0,failures:[...new Set(failures)]};
}
