import {createHash} from 'node:crypto';
import {assessReferenceRuns} from './reference-policy.mjs';
import {assessSupportMatrix} from './support-policy.mjs';
import {assessUsability} from './usability-policy.mjs';

export function coreClosure(backlog) {
  const cards=[],seen=new Set(),failures=[];
  if(typeof backlog!=='string')return {valid:false,cards:[],openCards:[],failures:['Backlog record is absent.']};
  for(const match of backlog.matchAll(/^### ([A-Z][0-9]{2}) — [^\n]+\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    const [,id,body]=match,status=/^\*\*Status:\*\* ([^\n]*?) · \*\*Scope:\*\* (CORE|NEXT|GATED|DEFERRED)/m.exec(body);
    if(seen.has(id)||!status){failures.push(`Missing/duplicate task status: ${id}`);continue}
    seen.add(id);cards.push({id,status:status[1],scope:status[2]});
  }
  if(cards.length!==55||cards.filter(card=>card.scope==='CORE').length!==45||!cards.some(card=>card.id==='Q05'&&card.scope==='CORE'))failures.push('Expected complete 55-card / 45-CORE backlog inventory.');
  const openCards=cards.filter(card=>card.scope==='CORE'&&card.id!=='Q05'&&!/^Done(?:\b|\s)/.test(card.status)).map(card=>card.id);
  if(openCards.length)failures.push(`CORE tasks remain open: ${openCards.join(', ')}`);
  return {valid:!failures.length,cards,openCards,failures,sha256:createHash('sha256').update(backlog).digest('hex')};
}

// These inputs determine media behavior, the build environment, brand and deps.
const runtime=path=>/^(components|services|types|assets|licenses)\//.test(path)||
  (!path.includes('/')&&(/\.(?:[cm]?tsx?|css|html)$/.test(path)||['brand.json','package.json','package-lock.json','tsconfig.json','tsconfig.mcp.json','.node-version','.npmrc'].includes(path)));
export function referenceChanges(before,after) {
  if(!Array.isArray(before)||!before.length||!Array.isArray(after)||!after.length)return {valid:false,changed:[],runtimeChanged:['Source inventories are absent.']};
  for(const items of [before,after])if(items.some(item=>typeof item?.path!=='string'||!item.path||!/^[a-f0-9]{64}$/.test(item.sha256??''))||new Set(items.map(item=>item.path)).size!==items.length)
    return {valid:false,changed:[],runtimeChanged:['Invalid or duplicate source inventory inputs.']};
  const map=items=>new Map(items.map(item=>[item.path,item.sha256]));
  const old=map(before),current=map(after),changed=[...new Set([...old.keys(),...current.keys()])].filter(file=>old.get(file)!==current.get(file)).sort();
  const runtimeChanged=changed.filter(runtime);
  return {valid:runtimeChanged.length===0,changed,runtimeChanged,
    decision:runtimeChanged.length?'Full reference must be rerun on the changed runtime.':'Media/build/brand/dependency inputs unchanged; tool/docs changes still require clean integrated checks and review.'};
}

export function assessRelease({candidate,reference,support,study,backlog,source,lockfileSha256}) {
  const failures=[],closure=coreClosure(backlog),changes=referenceChanges(reference?.sourceInputs,source?.inputs),hash=source?.sha256;
  const counts=candidate?.counts;
  if(candidate?.status!=='passed'||candidate.source?.inputsSha256!==hash||candidate.lockfileSha256!==lockfileSha256||
    !Array.isArray(candidate.steps)||candidate.steps.length!==11||!candidate.steps.every(step=>step?.status==='passed'&&step.exitCode===0&&!step.timedOut&&!step.signal)||
    new Set(candidate.steps.map(step=>step.name)).size!==11||!['check:toolchain','typecheck','check:mcp','test:unit','build','check:build-isolation','check:style-isolation','check:artifacts','test:diagnostic','test:browser','test:production'].every(name=>candidate.steps.some(step=>step.name===name))||
    !counts?.unit?.passed||counts.unit.failed||counts.unit.cancelled||counts.unit.passed+counts.unit.skipped!==counts.unit.total||
    (counts.unit.skipped&&!(counts.unit.skipped===1&&counts.unit.explainedOptionalSkips?.[0]==='Private reference absent; synthetic legacy migration remains required.'))||
    !counts?.browser?.passed||counts.browser.skipped||counts.browser.passed!==counts.browser.total||counts?.production?.passed!==4||counts.production.total!==4||counts.production.skipped)
    failures.push('Exact-source required qualification is incomplete.');
  const full=assessReferenceRuns(reference?.runs,reference?.sourceInputsSha256);
  const inventoryHash=items=>createHash('sha256').update(JSON.stringify(items)).digest('hex');
  if(reference?.status!=='passed'||!full.valid||!changes.valid||inventoryHash(reference?.sourceInputs)!==reference?.sourceInputsSha256||inventoryHash(source?.inputs)!==hash)failures.push('Full reference evidence is absent, failed or requires requalification.');
  const devices=assessSupportMatrix(support,hash),users=assessUsability(study,support,hash);
  if(!devices.valid)failures.push('Physical device/Flow evidence is incomplete.');
  if(!users.valid)failures.push('Representative-user workflow evidence is incomplete.');
  if(!closure.valid)failures.push(...closure.failures);
  return {valid:failures.length===0,failures,closure,referenceChanges:changes,physical:devices,usability:users};
}
