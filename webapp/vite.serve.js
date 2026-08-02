// Local dev viewer (`npm run test_serve`): assets are static files served
// straight from public/, same-origin. No tile-reconstruction commands, no
// COPC point dump, no /meta — those live in vite.reconstruction_serve.js. No
// S3 URL — that's vite.prod.js's concern.
import { defineConfig } from "vite";

import { baseConfig, OVH_ASSET_URL, servePlugins } from "./vite.common.js";

// `./test_serve --remote` sets ALPINEVIEW_REMOTE_ASSETS: assets then come from
// the OVH bucket instead of public/, and no local API is involved.
const ASSET_BASE_URL = process.env.ALPINEVIEW_REMOTE_ASSETS ? OVH_ASSET_URL : "";

// Mirrors what the S3 bucket will serve in prod, so caching behaves the same
// locally: content-addressed tile files cached for 3 days, fetchable cross-origin.
const ASSET_PATHS = /^\/(tiled3d|tiles|vegetation|terrain|wm|draco)\//;

const assetCacheHeadersPlugin = () => ({
  name: "asset-cache-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (ASSET_PATHS.test(req.url)) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      next();
    });
  },
});

export default defineConfig({
  ...baseConfig,
  plugins: [...servePlugins(), assetCacheHeadersPlugin()],
  define: {
    __TEST_CONTROLS__: "false",
    __API_BASE_URL__: JSON.stringify(ASSET_BASE_URL),
  },
});
