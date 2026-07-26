# AlpineView — CLAUDE.md

3D mountain viewer for the French Alps (3dalpsview.fr). LiDAR HD point clouds are meshed offline
(`alpineview_ewoks` + `alpineview_builder`) into Draco tiles served statically (`alpineview_api`,
or Vite middleware in dev). The web frontend lives in `webapp/` (Vite 6, three.js, ESM).

One frontend: `webapp/index.html` + `webapp/src/`, built on
[iTowns](https://github.com/iTowns/itowns) (npm `itowns@2.46`, peer `three@^0.174`). The port from
the old custom Three.js engine is **done** — `src/itowns/` was flattened into `src/` and the legacy
engine (`tileManager.js`, `camera.js`, `scene.js`) deleted in `04cb68b`. "Legacy" below refers only
to the surviving km/Y-up coordinate frame, not to a second app.

Run: `cd webapp && npm run dev` (= `test_serve`), open `/`. `npm run test_build_and_serve` adds the
build servers + `/debug/*` routes. Tests: `npm test` (vitest), `npm run test:smoke` (playwright).
`index.html` is the single rollup input in `vite.common.js`.

## App architecture (`webapp/src/`)
TODO
## Coordinate frames (load-bearing)

| | units | axes |
|---|---|---|
| Legacy frame (`buildCanvas`, `buildings.js`) | km | x=east, y=up, z=−north (Y-up) |
| iTowns planar | m | x=east, y=north, z=up (Z-up) |
| Raw `.drc` files | km | x=east, y=north, z=up — **relative to the parent 1 km cell origin** (`floor(tx/2^z)`) |

Raw Draco matches the iTowns frame directly: `mesh.scale = 1000`,
`mesh.position = (ox·1000, oy·1000, 0)` — no rotation. Direction conversion legacy→iTowns:
`(x, y, z) → (x, −z, y)`.
`buildCanvas`/`bakeUVs` still speak the legacy frame (km, z=−north); `dracoLayer.js` converts at
the call site.

## iTowns internals worth knowing (verified on 2.46 sources in node_modules)

- **Attached layers**: `view.addLayer(layer)` on a PlanarView attaches to `view.tileLayer`;
  the MainLoop calls `attachedLayer.update(context, layer, tileNode)` per traversed node, *after*
  `TiledGeometryLayer.update` has set `node.visible` / `node.material.visible` for the frame.
  Reference implementation: `lib/Layer/GeoidLayer.js`. `Layer` accepts `source: false`.
- **Log depth buffer**: the iTowns renderer enables `logarithmicDepthBuffer`. Any custom
  `ShaderMaterial` must include `logdepthbuf_pars_vertex/fragment` + `logdepthbuf_vertex/fragment`
  chunks or its depth is on a different scale (far-over-near artifacts, floating geometry).
  Done in `buildVerticalDiffuseMaterial` and the `buildings.js` shader.
- **Depth picking**: wheel zoom / smart travel target comes from `view.getPickingPositionFromDepth`,
  which re-renders **only `tileLayer.object3d`** in a depth-encoding mode (`RenderMode`).
  Draco meshes are invisible to it, and we hide the DEM tiles they cover — so `dracoLayer.js`
  wraps `view.readDepthBuffer` to temporarily un-hide those DEM tiles during the read (DEM ≈ LiDAR
  surface within metres). Without this, picking falls back to a flat plane at `groundLevel` (200 m)
  and wheel zoom goes wild near drc tiles.
- **PlanarControls quirks**: wheel zoom is an animated 0.2 s "travel" (`zoomTravelTime`); wheel
  events arriving during a travel are dropped (`STATE !== NONE`). Zoom step ∝ distance to the
  picked point. `maxAltitude` (default **12 000 m**) silently blocks zoom-out above that altitude —
  relevant in the Alps. Options go in `PlanarView` opts as `controls: {...}` (`instantTravel`,
  `zoomTravelTime`, `maxAltitude`).
- **Subdivision knobs**: `maxSubdivisionLevel` and `sseSubdivisionThreshold` (default 1.0; higher →
  subdivide later → fewer deep tiles) are `PlanarLayer` options forwarded from `PlanarView` opts.
- **LayeredMaterial** (DEM tiles): has `fog = true` (scene fog just works), per-node diffuse
  lighting via `material.setUniform('lightingEnabled', bool)` + `'lightPosition'` (dir, Z-up;
  formula `min(2·dot(N,L),1)` — can go negative/black on back faces), but does **not** sample
  three.js shadow maps (cast shadows appear on draco terrain only).
- **Render on demand**: iTowns renders only on `view.notifyChange(source)` — call it after any
  async mutation (tile added, uniform changed) or nothing repaints.
- **Depth picking doesn't see `view.scene` extras**: `readDepthBuffer` renders only
  `tileLayer.object3d`. Objects added straight to `view.scene` — draco tiles (their own group is
  added to `view.scene` directly by `View.addLayer`, not nested under `tileLayer.object3d`),
  buildings, vegetation — are invisible to wheel-zoom/smart-travel picking; only the DEM tile
  underneath is ever picked. Accepted limitation, not fixed.

## Gotchas / conventions

- Single three.js copy required: `three` is pinned `^0.174` to satisfy itowns' peer dep; check
  `npm ls three` after dependency changes.
- `buildVerticalDiffuseMaterial` keeps legacy uniform defaults (`uLit=1`, `uBrightness` set via
  `setBrightness`) — nothing else depends on them now that the legacy app is gone, but the tests
  in `tests/layers.test.js` do.
- `/tiles|vegetation|buildings|dem` are proxied to the real `alpineview_api` in dev
  (`DEV_API_URL`, `vite.common.js`) exactly as in prod — no custom middleware, no `index.html`
  fallback. **Missing tiles 404**, and sparse coverage makes that the normal case, not an error:
  404 must be silent and never retried (`isTileMissing` in `dracoLayer.js`, `null` in
  `buildings.js`/vegetation). The 5-byte `"DRACO"` magic check survives as a corruption guard.
- Draco decoder wasm is copied to `/draco/` by `vite.common.js` (`DRACOLoader.setDecoderPath`).
- `src/consoleControls.js` — browser-console commands available everywhere, prod included
  (loaded unconditionally from `main.js`): `read_meta(x, y)`, `goto(x, y)`, `reload(x, y)`,
  `which(lod)`. Coordinates are Lambert-93 km = z=0 tile indices (y = south edge). `which`
  picks via `getPickingPositionFromDepth`
- `src/testControls.js` — dev-only browser-console commands, loaded from `main.js` behind
  `__TEST_CONTROLS__` (true only under `npm run test_build_and_serve`, which also mounts the
  `/debug/*` routes). `build(x, y)` (Lambert-93 km; centre of the screen if omitted) streams
  `/debug/build` output — the `tileBuildPlugin` route that rebuilds the containing cell.
- **No comments in code.** None — not inline, not block, not docstrings. Naming carries
  the explanation; anything that needs more belongs in this file.

## Not implemented

Ported since: Camptocamp POI (`poi.js`), mobile touch controls (`touchControls.js`), place search
(`main.js`, Nominatim). Still absent: COSIA layer and the 2D Leaflet map mode (both dropped — no
trace left in `src/`), fly/walk cameras, URL position write-back (`?x=&y=` is read-only at startup).
Known perf point: `computeVertexNormals` + imagery stitching run on the main thread
(`geometryWorkerPool.js` exists if needed).
