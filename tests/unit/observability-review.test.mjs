import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm,cp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readBounded,appendJournal,readExportLog} from '../../mcp-server/storage.js';
import {insertEntry,parseJournal,reportStatus} from '../../mcp-server/lib.js';
import {validateArguments} from '../../mcp-server/tools.js';
import {sanitizeReport,historicalReport} from '../../services/reportPolicy.mjs';
import {createProjectState} from '../../mcp-server/projectState.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const temporary=()=>mkdtemp(path.join(tmpdir(),'clipbraid-observability-review-'));
test('O01: a bounded tail never turns an incomplete single line into a new record',async()=>{
  const root=await temporary();
  try{const file=path.join(root,'long.log');await writeFile(file,'prefix '.repeat(1000)+'EXPORT EVENT {"type":"host-accepted"}');
    assert.equal((await readBounded(file,128,true)).text,'');
  }finally{await rm(root,{recursive:true,force:true})}
});
test('O01: symlinked parent directories cannot redirect journal reads or writes',async()=>{
  const root=await temporary();
  try{
    await mkdir(path.join(root,'real'));const original='# Journal\n\n---\n';await writeFile(path.join(root,'real/JOURNAL.md'),original);
    await symlink(path.join(root,'real'),path.join(root,'redirect'),'dir');
    const file=path.join(root,'redirect/JOURNAL.md');
    await assert.rejects(readBounded(file,1024),/symlink/i);
    await assert.rejects(appendJournal(file,'blocked','body'),/symlink/i);
    assert.equal(await readFile(path.join(root,'real/JOURNAL.md'),'utf8'),original);
  }finally{await rm(root,{recursive:true,force:true})}
});
test('O01: journal entries stay newest first without a separator and titles are one line',()=>{
  const text=insertEntry('# Journal\n\n## Older\nold','Newest','new',new Date('2026-10-26T12:00:00Z'));
  assert.match(parseJournal(text)[0].title,/Newest/);
  for(const separator of ['\u2028','\u2029'])assert.throws(()=>validateArguments('journal_append',{title:'first'+separator+'second',body:'body'}),/one-line/);
  assert.throws(()=>validateArguments('journal_append',Object.create({title:'inherited',body:'inherited'})),/Missing/);
});
test('O02: incomplete or conflicting summaries cannot become successful delivery',()=>{
  const base={schemaVersion:1,jobId:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64)+':production',updatedAt:new Date().toISOString()};
  for(const value of [{...base,outcome:'host-accepted'}, {...base,outcome:'host-accepted',phase:'rendering',cleanupComplete:false},
    {...base,outcome:'download-started',phase:'complete',cleanupComplete:true,buildId:'unqualified'}])
    assert.equal(reportStatus(value).verdict,'UNKNOWN');
});

test('O01: an empty current log cannot borrow an older alias outcome',async()=>{
  const root=await temporary();
  try{
    const current=path.join(root,'current.log'),old=path.join(root,'old.log');
    await writeFile(current,'');await writeFile(old,'old accepted outcome');
    const empty=await readExportLog(current,old);assert.equal(empty.text,'');assert.equal(empty.legacyFallback,false);
    await rm(current);const fallback=await readExportLog(current,old);assert.equal(fallback.text,'old accepted outcome');assert.equal(fallback.legacyFallback,true);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('O02: copied checkpoints and safe operation/frame observations retain their meaning',()=>{
  const report=sanitizeReport({schemaVersion:1,jobId:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64)+':test',phase:'rendering',
    outcome:'running',cleanupComplete:false,updatedAt:new Date().toISOString(),resources:[{operation:'decode-request',frame:12,sourceTime:.4,clipId:'private-name',ownedResources:-1}]});
  assert.deepEqual(report.resources,[{sourceTime:.4,frameIndex:12,operation:'decode-request'}]);
  const historical=historicalReport(report,null);assert.equal(historical.outcome,'unknown');assert(historical.warnings.includes('previous-session-unobserved'));
  assert.equal(report.outcome,'running');assert.equal(historicalReport(report,report.jobId),report);
  assert.doesNotMatch(JSON.stringify(historical),/private-name|clipId/);
});

test('O02: complete summaries need verified receipts and negative events retain precedence',()=>{
  const at=new Date().toISOString(),base={schemaVersion:1,jobId:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64)+':production',
    phase:'complete',cleanupComplete:true,outcome:'host-accepted',startedAt:at,updatedAt:at,endedAt:at,input:{fingerprint:'b'.repeat(64)},
    profile:{width:854,height:480,frames:30,fps:30,duration:1},events:[{type:'verified',at},{type:'host-accepted',at}]};
  assert.equal(reportStatus(base).verdict,'HOST_ACCEPTED');
  for(const [type,expected] of [['failed','FAILED'],['cancelled','CANCELLED'],['unknown','UNKNOWN']])
    assert.equal(reportStatus({...base,events:[...base.events,{type,at}]}).verdict,expected);
  assert.equal(reportStatus({...base,events:[]}).verdict,'UNKNOWN');
  assert.equal(reportStatus({...base,phase:'cleaning',outcome:'running',cleanupComplete:false,events:[{type:'failed',at}]}).verdict,'FAILED');
});

test('O01/O02: concurrent project-state calls share typecheck and detect source drift',async()=>{
  const root=await temporary();
  try{
    await mkdir(path.join(root,'reports'));await writeFile(path.join(root,'reports/build-artifacts.json'),JSON.stringify({source:{inputsSha256:'a'.repeat(64)},buildId:'a'.repeat(64)+':production'}));
    let checks=0,release,hash='a'.repeat(64);
    const execute=async command=>{if(command!=='git'){checks++;await new Promise(resolve=>{release=resolve})}return {stdout:'main'}};
    const provider=createProjectState(root,execute,async()=>({status:200}),()=>({sha256:hash}));
    const first=provider(),second=provider();assert.equal(first,second);
    while(!release)await new Promise(resolve=>setTimeout(resolve,0));hash='b'.repeat(64);release();
    const result=await first;assert.equal(checks,1);assert.equal(result.typecheckStatus,'stale');assert.equal(result.build.sourceMatches,false);assert.equal(result.build.artifactsVerified,false);
    const failed=createProjectState(root,async command=>{if(command!=='git')throw {stdout:'',stderr:'compiler failed',message:'failure'};return {stdout:'main'}},async()=>({status:200}),()=>({sha256:hash}));
    assert.match((await failed()).tsc,/compiler failed/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('O02: actual MCP tools redact current summaries and classify invalid JSON as unknown',async()=>{
  const root=await temporary();let client,transport;
  try{
    await mkdir(path.join(root,'services'));await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'reports/diagnostics'),{recursive:true});
    await cp(new URL('../../mcp-server/',import.meta.url),path.join(root,'mcp-server'),{recursive:true});
    await cp(new URL('../../services/reportPolicy.mjs',import.meta.url),path.join(root,'services/reportPolicy.mjs'));
    await cp(new URL('../../scripts/source-identity.mjs',import.meta.url),path.join(root,'scripts/source-identity.mjs'));
    await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');await writeFile(path.join(root,'package.json'),'{"type":"module"}');
    const file=path.join(root,'reports/diagnostics/latest.json'),at=new Date().toISOString();
    await writeFile(file,JSON.stringify({schemaVersion:1,jobId:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64)+':test',
      outcome:'host-accepted',phase:'complete',cleanupComplete:true,startedAt:at,updatedAt:at,endedAt:at,input:{fingerprint:'b'.repeat(64)},
      profile:{width:854,height:480,frames:30,fps:30,duration:1},events:[{type:'verified',at},{type:'host-accepted',at}],
      name:'private-person',base64:'secret-media',resources:[{operation:'/home/private-person',frame:4}]}));
    transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp-server/index.js')],stderr:'pipe'});
    client=new Client({name:'observability-review',version:'1.0.0'});await client.connect(transport);
    const copied=await client.callTool({name:'export_logs',arguments:{name:'latest'}});
    assert.equal(copied.isError,undefined);assert.doesNotMatch(copied.content[0].text,/private-person|secret-media|base64|home/);
    assert.equal(JSON.parse(copied.content[0].text).outcome,'host-accepted');
    await writeFile(file,'[');
    const invalid=await client.callTool({name:'e2e_status',arguments:{name:'latest'}});
    assert.equal(invalid.isError,undefined);assert.equal(JSON.parse(invalid.content[0].text).verdict,'UNKNOWN');
  }finally{await client?.close();await transport?.close();await rm(root,{recursive:true,force:true})}
});

test('project state reads a matching manifest through a trusted root alias without verifying artifact bytes', async () => {
  const directory = await realpath(await temporary());
  const physical = path.join(directory, 'physical'), alias = path.join(directory, 'alias');
  try {
    await mkdir(path.join(physical, 'reports'), { recursive: true });
    await symlink(physical, alias, 'dir');
    const hash = 'd'.repeat(64);
    await writeFile(path.join(physical, 'reports/build-artifacts.json'), JSON.stringify({ source: { inputsSha256: hash }, buildId: `${hash}:production` }));
    const state = createProjectState(alias, async () => ({ stdout: 'main' }), async () => ({ status: 200 }), () => ({ sha256: hash }));
    const result = await state();
    assert.equal(result.typecheckStatus, 'passed');
    assert.equal(result.build.sourceMatches, true);
    assert.equal(result.build.artifactsVerified, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
