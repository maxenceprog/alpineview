// Reconstruction-serve config (`npm run test_build_and_serve`): the plain
// viewer plus the reconstruction servers (redis + ewoksjob, via alpineview)
// and the dev-only /debug/* routes used by src/testControls.js. Never used
// for `npm run build`: these routes shell out to the reconstruction pipeline
// and must not be reachable from a production deployment.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { baseConfig, py, repoRoot, servePlugins } from "./vite.common.js";

const NUM = /^-?\d+(\.\d+)?$/;

// Start redis + ewoksjob monitor/worker alongside the dev server; the python
// process owns them (alpineview_ewoks.build_tiles_utils) and stops them on SIGTERM.
function reconstructionServersPlugin() {
  let proc = null;
  return {
    name: "reconstruction-servers",
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

// GET /debug/build?x=&y= (Lambert-93 km, floats) → reconstructs the cell
// containing that point via the ewoksjob worker (alpineview_ewoks.build_one_tile
// --no-servers) and streams its output. One reconstruction at a time; a second
// request gets a 409.
function tileReconstructionPlugin() {
  let running = null;

  return {
    name: "tile-reconstruction",
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
          res.end(`reconstruction already running: ${running}`);
          return;
        }
        // Cell containing the point, in LAZ NW-corner naming (y = north edge).
        const xKm = Math.floor(Number(x));
        const yKm = Math.floor(Number(y)) + 1;
        running = `${xKm} ${yKm}`;
        const args = ["-m", "alpineview_ewoks.build_one_tile", String(xKm), String(yKm), "--no-servers"];
        console.log(`[tile-reconstruction] ${py} ${args.join(" ")}`);
        const proc = spawn(py, args, { cwd: repoRoot });
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.on("error", () => {}); // client gone: keep the reconstruction running
        proc.stdout.pipe(res, { end: false });
        proc.stderr.pipe(res, { end: false });
        proc.stderr.pipe(process.stderr, { end: false });
        proc.on("close", (code) => {
          running = null;
          res.end(`\n[tile-reconstruction] exit ${code}\n`);
        });
      });
    },
  };
}

// GET /meta?x=&y=[&limit=] → build metadata for the z=0 tile (x, y), read
// straight out of webapp/public/tiles/meta.jsonl (one line per rebuild,
// written by alpineview_ewoks/core/tiles.py). Args are web tile indices
// (y = south edge); meta.jsonl keys cells by their LAZ NW-corner name
// (y = north edge), hence the +1. Replaces alpineview_api's /meta route,
// which is gone now that assets are static.
function metaPlugin() {
  const path = resolve(repoRoot, "webapp/public/tiles/meta.jsonl");

  return {
    name: "meta",
    configureServer(server) {
      server.middlewares.use("/meta", (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        const x = Number(searchParams.get("x"));
        const y = Number(searchParams.get("y"));
        const limit = Number(searchParams.get("limit") ?? 1);
        if (!NUM.test(searchParams.get("x") ?? "") || !NUM.test(searchParams.get("y") ?? "")) {
          res.statusCode = 400;
          res.end("x and y required");
          return;
        }
        const cell = { x_km: x, y_km: y + 1 };
        let lines;
        try {
          lines = readFileSync(path, "utf-8").split("\n");
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        const entries = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (entry.cell?.x_km === cell.x_km && entry.cell?.y_km === cell.y_km) {
            entries.push(entry);
          }
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          tile: { x, y },
          cell,
          count: entries.length,
          entries: entries.slice(-limit),
        }));
      });
    },
  };
}

export default defineConfig({
  ...baseConfig,
  plugins: [
    reconstructionServersPlugin(),
    debugCopcPlugin(),
    tileReconstructionPlugin(),
    metaPlugin(),
    ...servePlugins(),
  ],
  // Dev-only config: assets are proxied to the local alpineview_api, so same-origin.
  define: { __TEST_CONTROLS__: "true", __API_BASE_URL__: '""' },
});
