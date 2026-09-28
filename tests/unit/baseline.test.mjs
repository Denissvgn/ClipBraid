import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate } from '../source-probes.mjs';

// Known failures remain executable contracts: an unexpected pass forces the
// owning repair to remove the exception. Infrastructure errors are never masked.
function knownBroken(title, owner, check) {
  test(`${title} [known-broken: ${owner}]`, async () => {
    let assertion;
    try { await check(); } catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; assertion = error; }
    assert.ok(assertion, `Unexpected pass: review and remove ${owner}'s known failure`);
  });
}
test('fixture inventory byte identities are pinned', () => {
  const inventory = JSON.parse(readFileSync('tests/fixtures/manifest.json'));
  for (const [name, expected] of Object.entries(inventory)) {
    const bytes = readFileSync(`tests/fixtures/${name}`);
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, name);
  }
});
test('timeline bounds overlaps and keeps repeated-source clip edits independent', () => {
  const clampTransition = evaluate('App.tsx', 'clampTransition');
  const recalculate = evaluate('App.tsx', 'recalculateMediaStartTimes', { transitionDuration: 0.5, clampTransition });
  const input = [{id:'a',mediaId:'shared',duration:1},{id:'b',mediaId:'shared',duration:0.2}];
  const out = recalculate(input);
  assert.equal(out[0].startTime, 0);
  assert.equal(out[1].startTime, 0.9);
  assert.equal(out[1].transitionDuration, 0.1);
  assert.equal(input[1].startTime, undefined);
  out[0].duration=2;
  assert.equal(out[1].duration,0.2);
});
knownBroken('outgoing opacity stays opaque before overlap', 'transition timing', () => {
  const a = {id:'a',startTime:0,duration:6}, b={id:'b',startTime:5,duration:3,transitionDuration:1};
  const opacity = evaluate('App.tsx','opacityAt',{nextAssetOf:new Map([['a',b]])});
  const preview = evaluate('components/MediaPreview.tsx','calculateOpacity',{currentTime:4.5,mediaAssets:[a,b]});
  assert.deepEqual([opacity(a,4.5),preview(a)], [1,1]);
});
knownBroken('schema rejects newer versions before applying state', 'project validation', async () => {
  const effects=[];
  const scope={mediaAssets:[],audioTracks:[],setStatus:()=>{},setMediaAssets:()=>effects.push('media'),setAudioTracks:()=>effects.push('audio'),sysLog:()=>{}};
  const load=evaluate('App.tsx','loadProjectText',scope);
  const accepted=await load(readFileSync('tests/fixtures/drafts/future-version.json','utf8'));
  assert.deepEqual({accepted,effects},{accepted:false,effects:[]});
});
knownBroken('Final payload cannot signal completed delivery', 'delivery status', () => {
  const done=evaluate('mcp-server/index.js','done',{logText:'Final payload: 2 MB\nEXPORT FAILED: save rejected'});
  assert.equal(done,false);
});
knownBroken('long-project video floor respects the displayed size target', 'size estimates', () => {
  const estimate = evaluate('App.tsx','exportEstimate',{useMemo: fn=>fn(),exportQuality:'draft',totalDuration:3600});
  const minimumMiB = (estimate.kbps*1000+192000)*3600/8/1048576;
  assert.ok(minimumMiB <= estimate.mb, `floor predicts ${minimumMiB} MiB`);
});
