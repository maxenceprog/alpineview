# webapp

3D viewer for French Alps LiDAR HD terrain. iTowns `PlanarView` in **Lambert-93
(EPSG:2154)**, terrain served as an **OGC 3D Tiles** tileset, IGN WMTS imagery
draped on it at runtime.

Everything is in metres of L93 with **Z up**. Tile grids are indexed in
kilometres from the L93 origin.

## Commands

```
npm run dev          # = test_serve: vite, assets proxied to a local alpineview_api
npm run test_build_and_serve  # + redis/ewoksjob build servers and /debug/* routes
npm run build        # static bundle (GitHub Pages), absolute API URL baked in
npm test             # vitest
npm run test:smoke   # playwright (stale — waits for #status, which no longer exists)
npm run lint
```

`npx eslint` crashes in its stylish formatter on this Node; use
`npx eslint -f json` when there are findings to print.

## Terrain: 3D Tiles

SKIRT ARE NOT USED ANYMORE !!!

`/tiled3d/tileset.json` is the **single source of truth for what terrain
exists**. It is stitched by `scripts/build_root_tileset.py` from the tiles
actually built, so anything absent from it is absent from the app. There is no
`bom_hd.txt` / `bom_ld.txt` any more — `src/tilesetCoverage.js` derives covered
1 km cells from the tileset instead, and the HD-availability map reads that.
**The HD zone is where level-2 content exists**; coarser levels reach
everywhere the pyramid does and say nothing about LiDAR HD coverage.

Terrain cells are indexed as `(tx, ty, z)` covering `1000 / 2^z` metres —
`z = 0` is a 1 km cell, `z = -2` a 4 km one, `z = 2` a 250 m one — but on disk
tiles carry **3D Tiles implicit quadtree** names, `tile.{x}.{y}.{level}.glb`
with `level = IMPLICIT_LEVEL0 + z`. The quadtree's level-0 cell is a declared
EPSG:2154 zone covering the whole French Alps: `x 768..1280`, `y 6144..6656` km
(`ROOT_X0_KM`, `ROOT_Y0_KM`, `IMPLICIT_LEVEL0 = 9`), duplicated in
`scripts/build_root_tileset.py` and `alpineview_builder/src/mesh_lod.cpp` and
required to match. It is deliberately **not** fitted to what is built — the
margin absorbs both future expansion and the low-def skirt, which reaches far
outside the HD zone (z=-2 spans 200×260 km against 62×122 km at z=0). Changing
any of the three constants renames every tile on disk; `scripts/
rebase_implicit_tile_names.py` does that, using the BOM's `(tx, ty, z)` as the
stable link. It stages through a temporary suffix because the schemes are
translations of each other, so a destination name is usually some other tile's
source name — renaming in one pass silently destroys files.

Geometry is baked as `world_L93 - ORIGIN` where `ORIGIN = (900000, 6400000, 0)`;
the root tileset's transform puts it back. That offset exists because baking
absolute L93 into float32 costs 12–25 cm of precision.

The glTF carries **POSITION and NORMAL** — no UVs. Normals are baked with a
single **global** orientation flip (flip the whole mesh only if its winding
faces down), never a per-vertex flip-to-+Z, which would invert overhangs. UVs
are produced at load time in `src/tilesTexture.js`.

Pipeline (repo root). Two producers, one coordinate frame (`world_L93 -
ORIGIN`), both feeding one stitcher:
- `alpineview_builder` (C++) rebuilds the **fine levels (z ≥ 2)** and writes
  each cell's tiles + a per-cell `bom.{x}.{y}.jsonl`. Draco is native. Note it
  emits `0..maxlv`, so its z0/z1 would overwrite the Python-owned coarse tiles if
  pointed straight at `tiled3d` — keep the two producers' levels disjoint.
- `scripts/tiles_to_glb_batch.py` converts the **coarse levels (z ≤ 1)** from
  the `.drc` tiles (`public/oldtile` for z 0/1 — `public/tiles` 0/1 are corrupt;
  `public/tiles` for z -1/-2), Draco-compressed via `gltf-pipeline` (installed
  once into `~/.cache/alpineview-gltf-pipeline`, called as a binary — not per-tile
  `npx`). Writes a single `bom.jsonl`.
- `scripts/build_root_tileset.py` globs every `bom*.jsonl` and emits the
  implicit `tileset.json` plus `subtrees/{level}.{x}.{y}.subtree`. Implicit
  tiling supplies the aggregation nodes above the coarsest level for free, so
  frustum culling still prunes whole branches. `SUBTREE_LEVELS` is *derived* as
  `IMPLICIT_LEVEL0 + COARSEST_Z` (= 7), putting the only subtree tier boundary
  exactly on the coarsest content level so one tier spans every content level:
  one root subtree above the data, then one ~1.4 KB subtree per built 4 km cell,
  lazily fetched. Keep it small — the viewer's `SUBTREELoader` walks a full
  `4^subtreeLevels` nodes per subtree regardless of sparsity, so an all-in-one
  subtree hangs the browser. The script hard-fails on any tile falling outside
  the root cell rather than emitting a name that silently wraps.

`update_bill_of_materials.py` now only writes `bom_buildings.txt`.

## Imagery

`src/wmts.js` is the one way to get IGN imagery: `fetchWmtsCanvas(extent,
sourceKey)` returns a canvas covering **exactly** the requested L93 extent,
stitched from the WMTS tiles overlapping it at a zoom derived from the extent's
size. Callers map UVs straight against the extent they asked for. Sources are
`ortho` (HR.ORTHOIMAGERY) and `plan` (PLANIGNV2); `setMapSource` switches which
one subsequent fetches use. A 404 from IGN is normal (sea, coverage gaps) and
must never fail the surrounding mosaic.

`src/tilesTexture.js` drapes it on the tileset: on each `load-model` it derives
the mesh's L93 footprint from its world bounding box (via `matrixWorld`, so the
ORIGIN transform is already applied), bakes UVs against it, and swaps in
`buildVerticalDiffuseMaterial`. It uses the tile's baked normals (only computes
them if a tile lacks them). Its `refreshTextures()` re-drapes loaded tiles after
a `setMapSource` switch.

## Layers and lighting

`src/layers.js` holds `buildVerticalDiffuseMaterial` — the shared terrain
shader: fog, shadows, sun direction, brightness lift, and a `MODE_DEPTH` branch
that packs depth to RGBA so iTowns' depth picking sees the mesh. Materials
register themselves with `src/sunLighting.js`, so `setBrightness` /
`setSunDirection` reach every one of them at once. Always go through
`replaceMeshMaterial` / `disposeLayerMaterials` — they dispose the texture in
`uniforms.map`, which `material.dispose()` alone does not.

`src/environment.js` owns sun position (suncalc, via `src/sun.js`), shadows and
fog, and returns `{ setSunDate, setEnabled, setShadowsEnabled }`.

## The invisible planar grid

`main.js` still creates iTowns' planar `tileLayer` (`maxSubdivisionLevel: 12`,
`segments: 1`) because the POI and buildings layers subdivide off its nodes —
POI at zoom 10–12, buildings at level 11. The 3D tileset is the visible ground,
so a `BEFORE_RENDER` requester sets `material.visible = false` on every grid
node. Do not remove the grid without rehoming both layers.

## Interaction

The tileset answers every terrain question the controls ask:
`view.getPickingPositionFromDepth` is overridden to raycast it, wheel-zoom is
gated on a usable pick, and smart travel drop-tests against it. Smart travel
**teleports** — no animated flight.

`src/touchControls.js` replaces the touch gestures wholesale (1 finger orients,
2 fingers move/zoom/rotate, double-tap travels).

## UI

`src/ui.js` wires `index.html`'s chrome — map toggle, sun/light panel, help
panel, search — to a view, taking `refreshTextures` as a parameter. `index.html`
carries all CSS inline. `src/poi.js` is the Camptocamp waypoint layer: labels,
the info panel, and search. Everything runs only on frames where the camera
matrix actually changed. Culling using terrain tiles bbox.

Console helpers (`src/consoleControls.js`, prod too): `read_meta`, `goto`,
`which`, `mem`. `src/testControls.js` adds `build(x, y)` under
`__TEST_CONTROLS__`. `window.view`, `window.tilesLayer` and `window.frameTileset`
are exposed for poking from the console.

## Assets

`public/tiled3d` is the live terrain. `public/buildings` holds `.city.jsonl`
plus `bom_buildings.txt`. `public/tiles`, `public/oldtile` and
`public/vegetation` are pipeline **inputs** now, not served content — the app no
longer fetches them, though `vite.common.js` still proxies those routes.
`public/ogc3d_test` is a leftover from the migration.
