import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  use: {
    baseURL: "http://localhost:5173",
    bypassCSP: true,
  },
  webServer: {
    // ../test_serve, not `npm run dev`: the asset routes are proxied to
    // alpineview_api, which that script starts alongside the dev server.
    command: "../test_serve",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [{ name: "chromium", use: { channel: "chromium" } }],
});
