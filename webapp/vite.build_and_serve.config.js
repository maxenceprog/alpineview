// Build-and-serve config (`npm run test_build_and_serve`): the plain viewer
// plus the build servers (redis + ewoksjob, via alpineview) and the dev-only
// /debug/* routes used by src/testControls.js. Never used for `vite build`:
// these routes shell out to the reconstruction pipeline and must not be
// reachable from a production deployment.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { baseConfig, py, repoRoot, servePlugins } from "./vite.common.js";

const NUM = /^-?\d+(\.\d+)?$/;

// Start redis + ewoksjob monitor/worker alongside the dev server; the python
// process owns them (alpineview_ewoks.build_tiles_utils) and stops them on SIGTERM.
function buildServersPlugin() {
  let proc = null;
  return {
    name: "build-servers",
    configureServer(server) {
      proc = spawn(py, ["-m", "alpineview_ewoks.build_tiles_utils"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      const stop = () => proc?.kill();
      server.httpServer?.on("close", stop);
      process.on("exit", stop);
    },
  };
}

// GET /debug/copc?x=&y=[&bbox=] → runs the COPC reader for the cached tile
// covering (x, y) (Lambert-93 metres) and streams back a `.stk1` point dump
// within a bbox x bbox metre square (see scripts/debug_copc_points.py).
function debugCopcPlugin() {
  const script = resolve(repoRoot, "scripts/debug_copc_points.py");

  return {
    name: "debug-copc",
    configureServer(server) {
      server.middlewares.use("/debug/copc", (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        const x = searchParams.get("x");
        const y = searchParams.get("y");
        const bbox = searchParams.get("bbox");
        if (!NUM.test(x ?? "") || !NUM.test(y ?? "")) {
          res.statusCode = 400;
          res.end("x and y (Lambert-93 metres) required");
          return;
        }
        const args = [script, x, y];
        if (bbox != null) {
          if (!NUM.test(bbox)) {
            res.statusCode = 400;
            res.end("bbox must be numeric (metres)");
            return;
          }
          args.push("--bbox", bbox);
        }
        const proc = spawn(py, args, { cwd: repoRoot });
        const err = [];
        proc.stderr.on("data", (d) => err.push(d));
        res.setHeader("Content-Type", "application/octet-stream");
        proc.stdout.pipe(res);
        proc.on("close", (code) => {
          if (code !== 0 && !res.headersSent) {
            res.statusCode = 500;
            res.end(Buffer.concat(err).toString() || `exit ${code}`);
          }
        });
      });
    },
  };
}

// GET /debug/build?x=&y= (Lambert-93 km, floats) → rebuilds the cell containing
// that point via the ewoksjob worker (alpineview_ewoks.build_one_tile --no-servers)
// and streams its output. One build at a time; a second request gets a 409.
function tileBuildPlugin() {
  let running = null;

  return {
    name: "tile-build",
    configureServer(server) {
      server.middlewares.use("/debug/build", (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        const x = searchParams.get("x");
        const y = searchParams.get("y");
        if (!NUM.test(x ?? "") || !NUM.test(y ?? "")) {
          res.statusCode = 400;
          res.end("x and y (Lambert-93 km) required");
          return;
        }
        if (running) {
          res.statusCode = 409;
          res.end(`build already running: ${running}`);
          return;
        }
        // Cell containing the point, in LAZ NW-corner naming (y = north edge).
        const xKm = Math.floor(Number(x));
        const yKm = Math.floor(Number(y)) + 1;
        running = `${xKm} ${yKm}`;
        const args = ["-m", "alpineview_ewoks.build_one_tile", String(xKm), String(yKm), "--no-servers"];
        console.log(`[tile-build] ${py} ${args.join(" ")}`);
        const proc = spawn(py, args, { cwd: repoRoot });
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.on("error", () => {}); // client gone: keep the build running
        proc.stdout.pipe(res, { end: false });
        proc.stderr.pipe(res, { end: false });
        proc.stderr.pipe(process.stderr, { end: false });
        proc.on("close", (code) => {
          running = null;
          res.end(`\n[tile-build] exit ${code}\n`);
        });
      });
    },
  };
}

export default defineConfig({
  ...baseConfig,
  plugins: [
    buildServersPlugin(),
    debugCopcPlugin(),
    tileBuildPlugin(),
    ...servePlugins(),
  ],
  define: { __TEST_CONTROLS__: "true" },
});
