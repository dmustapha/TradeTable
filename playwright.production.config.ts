import {defineConfig, devices} from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser-production",
  outputDir: "output/playwright/ui-redesign-verification-20260811/production-results",
  reporter: [["line"]],
  use: {baseURL: "https://tradetable-solana.vercel.app", trace: "retain-on-failure"},
  projects: [
    {name: "chromium", use: {...devices["Desktop Chrome"], viewport: {width: 1440, height: 1000}}},
    {name: "mobile", use: {...devices["Desktop Chrome"], viewport: {width: 390, height: 844}}},
  ],
});
