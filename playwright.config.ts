import { defineConfig, devices } from '@playwright/test';

// Tests run against their own copy of the app on port 3100, so a copy you
// started by hand on port 3000 never gets in the way. Chaos switches pass
// through, e.g.  CHAOS=reseed npx playwright test
const PORT = 3100;

// Chromium by default keeps demo runs fast and each failure reported once.
// CROSS=1 adds Firefox and WebKit (Safari's engine, which iPhone users run).
const CROSS = process.env.CROSS === '1';

export default defineConfig({
  testDir: './tests',
  // The Warden's self-test suite is deliberately weak; only the Warden runs it.
  testIgnore: process.env.WARDEN_SELFTEST === '1' ? [] : ['**/warden-selftest/**'],
  fullyParallel: false,
  workers: 1, // the app keeps state in memory; tests reset it via /__test/reset
  retries: 0, // retries hide the failures the Warden is meant to classify
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]],
  use: {
    // Loopback IP, not "localhost": every new API request context resolves the host
    // via getaddrinfo, and on macOS the IPv6 lookup for "localhost" now and then
    // stalls for 5 s (the action timeout). An IP literal skips name resolution.
    baseURL: `http://127.0.0.1:${PORT}`,
    // Fail fast: a page or action slower than 5 seconds is a timing problem, not a pass.
    actionTimeout: 5_000,
    navigationTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(CROSS
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
          { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
        ]
      : []),
  ],
  webServer: {
    command: 'node app/server.js',
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
  },
});
