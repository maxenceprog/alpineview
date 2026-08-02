import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";

export const repoRoot = resolve(import.meta.dirname, "..");
export const py = "python3";

export const OVH_ASSET_URL = "https://lidalps3d.s3.sbg.io.cloud.ovh.net";

// Serves (dev) / copies into dist (build): the Draco decoder shipped with
// three.js, so it doesn't need a manual pre-build copy step, and the root
// NOTICE.md — the bundle redistributes three.js et al., whose licenses require
// their notices to ship with it.
const staticCopyPlugin = () =>
  viteStaticCopy({
    targets: [
      {
        src: "node_modules/three/examples/jsm/libs/draco/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js}",
        dest: "draco",
      },
      { src: resolve(repoRoot, "NOTICE.md"), dest: "." },
    ],
  });

export const servePlugins = () => [
  // Self-signed TLS so the dev server speaks HTTP/2 — over plain HTTP the
  // browser caps parallel tile fetches at ~6 connections per origin.
  basicSsl(),
  staticCopyPlugin(),
];

export const baseConfig = {
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
  server: {
    watch: {
      ignored: [
        "**/public/*tile*/**",
        "**/public/terrain",
        "**/public/wm",
        "**/public/vegetation",

      ],
    },
    fs: { allow: [repoRoot, "."] },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.js"],
  },
};
