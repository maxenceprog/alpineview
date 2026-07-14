import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Serve a public sub-directory at a given URL prefix, bypassing Vite's
// snapshot (which misses files created after startup or excluded from watching).
function servePublicDir(urlPrefix, subDir) {
  const dir = resolve(import.meta.dirname, "public", subDir);
  const MIME = {
    ".drc": "application/octet-stream",
    ".jsonl": "application/jsonl",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gz": "application/octet-stream",
  };
  return {
    name: `serve-${subDir}`,
    configureServer(server) {
      server.middlewares.use(urlPrefix, (req, res, next) => {
        const rel = decodeURIComponent(req.url.split("?")[0]);
        const filePath = resolve(dir, "." + rel);
        if (
          !filePath.startsWith(dir + "/") ||
          !existsSync(filePath) ||
          !statSync(filePath).isFile()
        ) {
          return next();
        }
        // Last-Modified + no-cache lets the browser 304 on unchanged tiles
        // while still picking up a regenerated one on the next request
        // (reloadTile's `cache: "reload"` skips this entirely when needed).
        const lastModified = statSync(filePath).mtime.toUTCString();
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Last-Modified", lastModified);
        if (req.headers["if-modified-since"] === lastModified) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          MIME[filePath.slice(filePath.lastIndexOf("."))] ??
            "application/octet-stream",
        );
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

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
  servePublicDir("/tiles", "tiles"),
  servePublicDir("/vegetation", "vegetation"),
  servePublicDir("/buildings", "buildings"),
  servePublicDir("/dem", "dem"),
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
