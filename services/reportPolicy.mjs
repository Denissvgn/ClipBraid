export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const BUILD_ID = /^[a-f0-9]{64}:(production|test|development)$/;
const phases=['idle','preparing','rendering','muxing','saving','cancelling','cleaning','cancelled','complete','failed'];
const activePhases=['preparing','rendering','muxing','saving','cancelling','cleaning'];
const outcomes=['running','failed','cancelled','unknown','aborted','download-started','host-accepted'];
const eventTypes=['started','heartbeat','rendered','muxed','verified','delivery-started','download-started','host-accepted','failed','cancelled','unknown'];
const categories=['asset','audio-level','processing','cleanup','rejected','cancelled','denied','unsupported','transport','unknown','size-limit'];
const warningCodes=['profile-conversion','cleanup-incomplete','delivery-uncertain','device-storage-unconfirmed','single-encoder-retry','previous-session-unobserved','evidence-incomplete'];
const operations=['decode-request','decode-ready','encode-request','encode-ready','input-released','finalize-request','finalize-ready'];
const numericResources=['elapsedMs','ownedResources','sourceLeases','segment','inputs','images','frameIndex','sourceTime','waitMs','decodersCreated','decodersActive','encodersCreated','encodersActive'];
const profileKeys=['width','height','fps','fpsNumerator','fpsDenominator','frames','duration','videoBitrate','audioBitrate'];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:0;
const oneOf=(value,allowed,fallback)=>allowed.includes(value)?value:fallback;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value?value:null;
const numbers=(value,keys)=>Object.fromEntries(keys.filter(key=>typeof object(value)[key]==='number'&&Number.isFinite(object(value)[key])&&object(value)[key]>=0&&object(value)[key]<=Number.MAX_SAFE_INTEGER).map(key=>[key,object(value)[key]]));

/** One allow-list for retained/copied browser reports and MCP report consumers. */
export function sanitizeReport(value){
  const data=object(value),input=object(data.input);
  if(data.schemaVersion!==1||typeof data.jobId!=='string'||!JOB_ID.test(data.jobId))return null;
  const report={schemaVersion:1,jobId:data.jobId,buildId:typeof data.buildId==='string'&&BUILD_ID.test(data.buildId)?data.buildId:'unqualified',
    startedAt:timestamp(data.startedAt),updatedAt:timestamp(data.updatedAt),endedAt:timestamp(data.endedAt),
    outcome:oneOf(data.outcome,outcomes,'unknown'),phase:oneOf(data.phase,phases,'idle'),progress:Math.min(100,finite(data.progress)),cleanupComplete:data.cleanupComplete===true,
    category:oneOf(data.category,categories,null),
    input:{fingerprint:typeof input.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(input.fingerprint)?input.fingerprint:null,
      clips:finite(input.clips),audioTracks:finite(input.audioTracks),duration:finite(input.duration),quality:oneOf(input.quality,['draft','standard','high'],'standard'),
      aspectRatio:oneOf(input.aspectRatio,['16:9','9:16','1:1'],'16:9'),fitMode:oneOf(input.fitMode,['contain','cover'],'contain')},
    profile:data.profile?numbers(data.profile,profileKeys):null,timingsMs:numbers(data.timingsMs,phases),
    warnings:Array.isArray(data.warnings)?data.warnings.filter(code=>warningCodes.includes(code)).slice(0,7):[],
    events:Array.isArray(data.events)?data.events.slice(-80).map(object).filter(event=>eventTypes.includes(event.type))
      .map(event=>({type:event.type,elapsedMs:finite(event.elapsedMs),at:timestamp(event.at)})):[],
    resources:Array.isArray(data.resources)?data.resources.slice(-32).map(point=>{
      const clean=numbers(point,numericResources),raw=object(point);
      if(clean.frameIndex===undefined&&typeof raw.frame==='number'&&Number.isFinite(raw.frame)&&raw.frame>=0)clean.frameIndex=finite(raw.frame);
      if(operations.includes(raw.operation))clean.operation=raw.operation;
      return clean;
    }):[]};
  let incomplete=false;
  const observedNegative=['failed','cancelled','unknown'].find(type=>report.events.some(event=>event.type===type));
  if(observedNegative)report.outcome=observedNegative;
  if(report.phase==='failed')report.outcome=report.outcome==='unknown'&&report.cleanupComplete?'unknown':'failed';
  else if(report.phase==='cancelled')report.outcome=report.cleanupComplete?'cancelled':'failed';
  else if(['download-started','host-accepted'].includes(report.outcome)){
    const profile=report.profile,integer=value=>Number.isSafeInteger(value)&&value>0;
    const proof=report.phase==='complete'&&report.cleanupComplete&&BUILD_ID.test(report.buildId)&&report.startedAt&&report.updatedAt&&report.endedAt&&report.input.fingerprint&&
      profile&&integer(profile.width)&&integer(profile.height)&&integer(profile.frames)&&profile.fps>=12&&profile.fps<=30&&profile.duration>0&&
      report.events.some(event=>event.type==='verified'&&event.at)&&report.events.some(event=>event.type===report.outcome&&event.at);
    if(!proof){report.outcome='unknown';incomplete=true}
  }else if(report.outcome==='running'&&(!activePhases.includes(report.phase)||report.cleanupComplete||!BUILD_ID.test(report.buildId)||!report.updatedAt)){
    report.outcome='unknown';incomplete=true;
  }
  if(incomplete&&!report.warnings.includes('evidence-incomplete'))report.warnings.push('evidence-incomplete');
  return report;
}

/** A saved checkpoint is an observation from another session, not resumed work. */
export function historicalReport(report,currentJobId){
  if(report.jobId===currentJobId)return report;
  if(report.outcome!=='running'){
    if(activePhases.includes(report.phase)&&!report.cleanupComplete)return {...report,warnings:[...new Set([...report.warnings,'previous-session-unobserved','cleanup-incomplete'])]};
    return report;
  }
  const pending=report.events.some(event=>event.type==='delivery-started')&&!report.events.some(event=>['download-started','host-accepted','cancelled'].includes(event.type));
  return {...report,outcome:'unknown',warnings:[...new Set([...report.warnings,'previous-session-unobserved',...(pending?['delivery-uncertain']:[])])]};
}
