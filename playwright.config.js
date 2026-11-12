import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const local = '/opt/pw-browsers/chromium'; // cloud sandboxes ship one browser here
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['iPhone 14'],
    browserName: 'chromium', // iPhone viewport and touch, Chromium engine (the only one installed everywhere)
    baseURL: 'http://localhost:4199',
    launchOptions: existsSync(local) && !process.env.CI ? { executablePath: local, args: ['--no-sandbox'] } : {},
  },
  webServer: { command: 'npx vite preview --port 4199 --strictPort', url: 'http://localhost:4199', reuseExistingServer: !process.env.CI },
});
