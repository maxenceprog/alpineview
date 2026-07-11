# AlpineView — CLAUDE.md

3D mountain viewer for the French Alps (montagne3d.fr). LiDAR HD point clouds are meshed offline
(`alpineview_ewoks` + `alpineview_builder`) into Draco tiles served statically (`alpineview_api`,
or Vite middleware in dev). The web frontend lives in `webapp/` (Vite 6, three.js, ESM).

Two frontends coexist during an incremental port:
- **Legacy app** — `webapp/index.html` + `webapp/src/main.js`: custom Three.js engine
  (`tileManager.js`, `camera.js`, `scene.js`...). Being replaced feature by feature.
- **iTowns app** — `webapp/itowns.html` + `webapp/src/itowns/`: the port target, built on
  [iTowns](https://github.com/iTowns/itowns) (npm `itowns@2.46`, peer `three@^0.174`).

Run: `cd webapp && npm run dev` (or `test_serve`), open `/itowns.html` (iTowns) or `/` (legacy).
Tests: `npm test` (vitest). Both entries are rollup inputs in `vite.common.js`.

## iTowns app architecture (`webapp/src/itowns/`)

- `main.js` — `PlanarView` in **EPSG:2154** (proj4 def registered via `itowns.CRS.defs`).
  View extent is a **1024×1024 km square aligned to the km grid**
  (`256000..1280000, 5952000..6976000`): the planar quadtree root is the extent, so level-10
  tiles are exactly 1×1 km and line up with the Draco tile grid (level = 10 + z).
  `maxSubdivisionLevel: 12` (level 11 = z1 500 m, level 12 = z2 250 m).
  Layers: IGN ortho + Plan IGN `ColorLayer`s and DEM `ElevationLayer`, all via WMS-R
  (`https://data.geopf.fr/wms-r/wms`, CRS EPSG:2154; DEM = `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES`,
  `image/x-bil;bits=32`, noDataValue −99999). URL params `?x=&y=` = L93 km (legacy convention).
- `dracoLayer.js` — `DracoTileLayer extends itowns.Layer` (`{ source: false }`), **attached layer**
  on the tile layer: `update(ctx, layer, node)` is called by iTowns for every traversed `TileMesh`.
  For nodes at level 10–12 it fetches `/tiles/tile.{tx}.{ty}.{z}.drc`
  (`tx = round(extent.west/1000 · 2^z)`), decodes with `DRACOLoader`, drapes IGN imagery via
  `buildCanvas` (reused from `../layers.js`), and adds the mesh to `layer.object3d`.
  When a mesh is displayed it sets the node's `material.visible = false` — the Draco mesh
  *replaces* the DEM tile; iTowns re-asserts tile visibility every frame, so no restore logic.
  Missing tiles → `failed` state, DEM stays. Cleanup on the node's `'dispose'` event.
- `environment.js` — sky gradient sphere (follows camera), sun/ambient/fill lights, PCF shadow map
  (±10 km ortho frustum following the camera), `FogExp2`, sun disc; `setSunDate(date)` drives the
  sun from suncalc (`../sun.js`) with old→new frame conversion; `setEnabled(on)` toggles the whole
  environment. `TileLightingLayer` (attached layer) enables `LayeredMaterial`'s built-in diffuse
  lighting on DEM tiles (`setUniform('lightingEnabled'/'lightPosition')`).
- Reused legacy modules: `layers.js` (WMTS imagery stitching `buildCanvas`, terrain shader
  `buildVerticalDiffuseMaterial`, `setBrightness`, `setTerrainLightingEnabled`, map source switch),
  `sun.js`, `sunLighting.js`, `apiConfig.js`.

## Coordinate frames (load-bearing)

| | units | axes |
|---|---|---|
| Legacy scene | km | x=east, y=up, z=−north (Y-up) |
| iTowns planar | m | x=east, y=north, z=up (Z-up) |
| Raw `.drc` files | km | x=east, y=north, z=up — **relative to the parent 1 km cell origin** (`floor(tx/2^z)`) |

Raw Draco matches the iTowns frame directly: `mesh.scale = 1000`,
`mesh.position = (ox·1000, oy·1000, 0)` — no rotation (the legacy worker's rotateX(−90°) exists
only for the legacy scene). Direction conversion legacy→iTowns: `(x, y, z) → (x, −z, y)`.
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
  Done in `buildVerticalDiffuseMaterial`; chunks are no-ops in the legacy renderer.
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

## Gotchas / conventions

- Single three.js copy required: `three` is pinned `^0.174` to satisfy itowns' peer dep; check
  `npm ls three` after dependency changes.
- Legacy shader `buildVerticalDiffuseMaterial` is shared by both apps — changes must stay
  backward-compatible (uniform defaults preserve legacy behaviour: `uLit=1`, `uBrightness` set
  via `setBrightness`).
- Dev server serves `public/tiles|vegetation|buildings` through custom middleware and returns
  `index.html` for missing files — always validate the 5-byte `"DRACO"` magic before decoding.
- Draco decoder wasm is copied to `/draco/` by `vite.common.js` (`DRACOLoader.setDecoderPath`).
- Minimal comments in code; comment only non-obvious constraints.

## Port status / not yet ported

Vegetation overlay, buildings (CityJSONL), COSIA layer, Camptocamp POI, fly/walk cameras +
mobile touch controls, place search, URL position sync (write-back), 2D Leaflet map mode.
Known perf point: `computeVertexNormals` + imagery stitching run on the main thread
(legacy app used a worker pool — `geometryWorkerPool.js` exists if needed).
