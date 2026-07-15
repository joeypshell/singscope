import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'mobile-webkit', use: { ...devices['iPhone 15 Pro'] } },
    {
      name: 'mobile-webkit-landscape',
      use: { ...devices['iPhone 15 Pro landscape'] },
      testMatch: /layout\.spec\.ts/,
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm build && pnpm preview --host 127.0.0.1',
        url: 'http://127.0.0.1:4173',
        env: {
          VITE_SINGSCOPE_REPORT_ENDPOINT:
            process.env.VITE_SINGSCOPE_REPORT_ENDPOINT ??
            'http://127.0.0.1:4173/functions/v1/analysis-report',
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
