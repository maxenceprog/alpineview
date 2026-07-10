// Plain viewer config (`npm run test_serve` / production build): serves the
// generated tiles/vegetation/buildings only. No build commands, no COPC point
// dump — those live in vite.build_and_serve.config.js.
import { defineConfig } from "vite";

import { baseConfig, servePlugins } from "./vite.common.js";

export default defineConfig({
  ...baseConfig,
  plugins: servePlugins(),
  define: { __TEST_CONTROLS__: "false" },
});
