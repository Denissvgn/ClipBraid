export const REQUIRED_BROWSER_SPECS = [
  'adapters.spec.mjs', 'audio-windows.spec.mjs', 'audio.spec.mjs', 'cancellation.spec.mjs', 'clipbraid.spec.mjs', 'decoder-reuse.spec.mjs',
  'delivery.spec.mjs', 'diagnostic-history.spec.mjs', 'diagnostics.spec.mjs', 'encoder-plan.spec.mjs', 'export-feedback.spec.mjs', 'export-size.spec.mjs', 'export.spec.mjs',
  'fidelity.spec.mjs', 'identity.spec.mjs', 'keyboard.spec.mjs', 'mix-levels.spec.mjs', 'originals.spec.mjs',
  'preflight.spec.mjs', 'product-language.spec.mjs', 'project-schema.spec.mjs', 'project-transaction.spec.mjs',
  'proxies.spec.mjs', 'recovery.spec.mjs', 'regressions.spec.mjs', 'review.spec.mjs', 'sources.spec.mjs', 'usability.spec.mjs', 'worker-startup.spec.mjs',
];
export function assessPlaywright(report, fullSuite = false) {
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
  return { tests, total: tests.length, passed: passed.length,
    skipped: tests.filter(test => test.expectedStatus === 'skipped' || test.results.some(result => result.status === 'skipped')).length,
    expectedFailures: tests.filter(test => test.expectedStatus === 'failed').map(test => test.title),
    missingSpecs, valid: tests.length > 0 && passed.length === tests.length && missingSpecs.length === 0 };
}
export function assessSmokeEvidence(value) {
  return !!value && /^[a-f0-9-]{36}$/.test(value.jobId??'') && /^[a-f0-9]{64}:(test|production)$/.test(value.buildId??'')
    && /^[a-f0-9]{64}$/.test(value.sha256??'') && Number.isSafeInteger(value.bytes) && value.bytes>0
    && value.job?.jobId===value.jobId && value.job?.buildId===value.buildId && value.job?.outcome==='download-started'
    && value.job?.cleanupComplete===true && /^[a-f0-9]{64}$/.test(value.job?.input?.fingerprint??'')
    && value.videoCodec==='avc' && value.audioCodec==='aac' && value.tone>.08 && value.silence<.005;
}
