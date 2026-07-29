// Production build (`npm run build`): static bundle for GitHub Pages, with
// the deployed asset bucket's absolute URL baked in. No dev server concerns
// (proxying, cache-header simulation, tile-reconstruction routes) belong
// here — see vite.serve.js and vite.reconstruction_serve.js.
import { defineConfig } from "vite";

import { baseConfig, OVH_ASSET_URL, servePlugins } from "./vite.common.js";

// Assets are static, hosted on an OVH S3 bucket. The built frontend is
// static too (GitHub Pages), so it needs the absolute URL baked in.
const PROD_API_URL = OVH_ASSET_URL;

export default defineConfig({
  ...baseConfig,
  base: process.env.GITHUB_PAGES ? "/alpineview/" : "/",
  plugins: servePlugins(),
  define: {
    __TEST_CONTROLS__: "false",
    __API_BASE_URL__: JSON.stringify(PROD_API_URL),
  },
});
