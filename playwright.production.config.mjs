import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/production',timeout:30000,globalTimeout:90000,workers:1,retries:0,forbidOnly:true,
  reporter:[['list'],['json',{outputFile:'reports/production-results.json'}]],
  outputDir:'test-results/production',
  use:{baseURL:'http://127.0.0.1:4177',channel:'chromium',headless:true},
  webServer:{command:'npm run preview -- --host 127.0.0.1 --port 4177 --strictPort',url:'http://127.0.0.1:4177',reuseExistingServer:false,timeout:30000},
});
