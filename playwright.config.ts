import {defineConfig, devices} from "@playwright/test";

const program = "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3";

export default defineConfig({
  testDir: "tests/browser",
  outputDir: "output/playwright/ui-redesign-verification-20260811/results",
  reporter: [["line"]],
  use: {baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure"},
  projects: [
    {name: "chromium", use: {...devices["Desktop Chrome"], viewport: {width: 1440, height: 1000}}},
    {name: "mobile", use: {...devices["Desktop Chrome"], viewport: {width: 390, height: 844}}},
  ],
  webServer: {
    command: `UI_TEST_FIXTURES=1 NEXT_PUBLIC_PROGRAM_ID=${program} NEXT_PUBLIC_NETWORK_LABEL='SOLANA DEVNET' WATCHPACK_POLLING=true npm run dev -- --turbopack`,
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
