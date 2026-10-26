import { defineConfig } from '@playwright/test';
import { readdirSync } from 'node:fs';
const specs=readdirSync(new URL('./tests/browser',import.meta.url)).filter(file=>file.endsWith('.spec.mjs')).sort();
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  globalTimeout: 900_000,
  expect: { timeout: 10_000 },
  workers: 1,
  // Give each spec its own worker/browser. Context isolation alone does not
  // bound browser-native codec state across an entire long qualification run.
  projects: specs.map(file=>({name:file.replace('.spec.mjs',''),testMatch:`**/${file}`})),
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'reports/browser-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    channel: 'chromium',
    headless: true,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort --mode test',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
