import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Asset layers served by alpineview_api, in dev as in prod.
export const API_LAYERS = ["tiles", "vegetation", "buildings", "dem"];

// Dev: the local alpineview_api the test_serve scripts start (see ../test_serve).
// Proxied rather than called cross-origin, so the app stays same-origin and keeps
// the dev server's HTTP/2 — and so API_BASE_URL is empty, as on a same-host deploy.
export const DEV_API_URL = process.env.ALPINEVIEW_API_URL ?? "http://127.0.0.1:8000";

// Prod: the deployed API (alpineview_api/deploy/vars.yml api_domain). The built
// frontend is static (GitHub Pages), so it needs the absolute URL baked in.
export const PROD_API_URL =
  process.env.VITE_API_BASE_URL ?? "https://vps121630.serveur-vps.net";

// The dev server is launched from inside the project env (conda), so the
// PATH python is the right interpreter for the debug/build helpers.
export const repoRoot = resolve(import.meta.dirname, "..");
export const py = "python3";

// Serves (dev) / copies into dist/draco (build) the Draco decoder shipped
// with three.js, so it doesn't need a manual pre-build copy step.
const dracoCopyPlugin = () =>
  viteStaticCopy({
    targets: [
      {
        src: "node_modules/three/examples/jsm/libs/draco/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js}",
        dest: "draco",
      },
    ],
  });

export const servePlugins = () => [
  // Self-signed TLS so the dev server speaks HTTP/2 — over plain HTTP the
  // browser caps parallel tile fetches at ~6 connections per origin.
  basicSsl(),
  dracoCopyPlugin(),
];

const apiProxy = () =>
  Object.fromEntries(API_LAYERS.map((layer) => [
    `/${layer}`,
    { target: DEV_API_URL, changeOrigin: true },
  ]));

export const baseConfig = {
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
  server: {
    proxy: apiProxy(),
    // Generated static tiles (thousands of .drc/.png/.gz files) don't need HMR
    // watching — watching them all exhausts the inotify limit (ENOSPC).
    watch: { ignored: ["**/public/tiles*/**", "**/public/vegetation/**", "**/public/dem/**"] },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.js"],
  },
};
