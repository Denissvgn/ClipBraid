export const REQUIRED_BROWSER_SPECS = [
  'adapters.spec.mjs', 'audio-windows.spec.mjs', 'audio.spec.mjs', 'cancellation.spec.mjs', 'clipbraid.spec.mjs', 'decoder-reuse.spec.mjs',
  'delivery.spec.mjs', 'diagnostic-history.spec.mjs', 'diagnostics.spec.mjs', 'edit-history.spec.mjs', 'encoder-plan.spec.mjs', 'export-feedback.spec.mjs', 'export-size.spec.mjs', 'export.spec.mjs',
  'fidelity.spec.mjs', 'identity.spec.mjs', 'keyboard.spec.mjs', 'mix-levels.spec.mjs', 'originals.spec.mjs',
  'preflight.spec.mjs', 'product-language.spec.mjs', 'project-schema.spec.mjs', 'project-transaction.spec.mjs',
  'proxies.spec.mjs', 'recovery.spec.mjs', 'regressions.spec.mjs', 'review.spec.mjs', 'sources.spec.mjs', 'usability.spec.mjs', 'worker-startup.spec.mjs',
];
export const REQUIRED_PRODUCTION_TESTS = [
  'the served production candidate matches the source identity and every emitted asset hash',
  'production query parameters cannot expose automation or development journal',
  'production favicon resolves to the emitted SVG',
  'production identity and package version remain usable with unavailable fonts',
];
export function processSucceeded(result){return result?.status===0&&!result.error&&!result.signal}
export function assessPlaywright(report, fullSuite = false, requirement = '') {
  const tests = [];
  const collect = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) tests.push({
      file: spec.file, title: spec.title, expectedStatus: test.expectedStatus, status: test.status, results: test.results ?? [],
    });
    for (const child of suite.suites ?? []) collect(child);
  };
  for (const suite of report?.suites ?? []) collect(suite);
  const passed = tests.filter(test => test.expectedStatus === 'passed' && test.status === 'expected' && test.results.length && test.results.every(result => result.status === 'passed'));
  const seen = new Set(tests.map(test => (test.file ?? '').replaceAll('\\', '/').split('/').at(-1)));
  const missingSpecs = fullSuite ? REQUIRED_BROWSER_SPECS.filter(file => !seen.has(file)) : [];
  const missingTests = requirement==='production'?REQUIRED_PRODUCTION_TESTS.filter(title=>!tests.some(test=>(test.file??'').replaceAll('\\','/').split('/').at(-1)==='isolation.spec.mjs'&&test.title===title)):[];
  const globalErrors = Array.isArray(report?.errors)?report.errors:report?.errors?[report.errors]:[];
  return { tests, total: tests.length, passed: passed.length,
    skipped: tests.filter(test => test.expectedStatus === 'skipped' || test.results.some(result => result.status === 'skipped')).length,
    expectedFailures: tests.filter(test => test.expectedStatus === 'failed').map(test => test.title),
    missingSpecs, missingTests, globalErrors, valid: tests.length > 0 && passed.length === tests.length && missingSpecs.length === 0 && missingTests.length === 0 && globalErrors.length === 0 };
}
export function assessSmokeEvidence(value, expectedSource = null) {
  return !!value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.jobId??'') && /^[a-f0-9]{64}:(test|production)$/.test(value.buildId??'')
    && (!expectedSource||value.buildId.startsWith(expectedSource+':'))
    && /^[a-f0-9]{64}$/.test(value.sha256??'') && Number.isSafeInteger(value.bytes) && value.bytes>0
    && value.job?.jobId===value.jobId && value.job?.buildId===value.buildId && value.job?.outcome==='download-started'
    && value.job?.cleanupComplete===true && /^[a-f0-9]{64}$/.test(value.job?.input?.fingerprint??'')
    && value.videoCodec==='avc' && value.audioCodec==='aac' && Number.isFinite(value.tone)&&value.tone>.08 && Number.isFinite(value.silence)&&value.silence>=0&&value.silence<.005
    && value.width===854&&value.height===480&&Number.isFinite(value.duration)&&value.duration>=.99&&value.duration<1.1
    && Number.isFinite(value.fps)&&Math.abs(value.fps-30000/1001)<.01&&Array.isArray(value.frames)&&value.frames.length===2
    && value.frames.every(pixel=>Array.isArray(pixel)&&pixel.length===4&&pixel.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&Math.min(...pixel.slice(0,3))>150&&Math.max(...pixel.slice(0,3))-Math.min(...pixel.slice(0,3))<25);
}
