// Plain viewer config (`npm run test_serve` / production build): assets come from
// alpineview_api — proxied to the local one when serving, called at its deployed URL
// when built. No build commands, no COPC point dump — those live in
// vite.build_and_serve.config.js.
import { defineConfig } from "vite";

import { baseConfig, PROD_API_URL, servePlugins } from "./vite.common.js";

export default defineConfig(({ command }) => ({
  ...baseConfig,
  base: process.env.GITHUB_PAGES ? "/alpineview/" : "/",
  plugins: servePlugins(),
  define: {
    __TEST_CONTROLS__: "false",
    // Serving goes through the dev proxy, so same-origin; a build is static and
    // needs the deployed API's absolute URL.
    __API_BASE_URL__: JSON.stringify(command === "build" ? PROD_API_URL : ""),
  },
}));
