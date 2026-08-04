# lidalps3d.fr

/!\ PROJECT STILL IN ALPHA PHASE /!\

## Project goal

An open source reuse of IGN data to get a detailed 3D web visualization
of the French Alps.

Contact me if you'd like to reuse my work, help out, or report a bug.

## Glossary

- **[WebMercatorQuad](https://www.ogc.org/standards/)** —
  standardized OGC tiling grid, the Web Mercator tiling scheme used both
  by the imagery tiles and by the terrain cells here.
- **[WMTS](https://www.ogc.org/standards/wmts/)** — Web Map Tile Service,
  OGC standard for serving images split into tiles (this is how IGN
  imagery is served).
- **[3D Tiles](https://www.ogc.org/standard/3dtiles/)** — OGC standard for
  streaming large 3D scenes as tiles, with levels of detail.
- **[glTF / .glb](https://www.khronos.org/gltf/)** — standard 3D mesh
  format; `.glb` is its single binary file variant.
- **[LiDAR HD](https://geoservices.ign.fr/lidarhd)** — IGN's high-density
  aerial LiDAR survey program (the source point cloud).
- **[RGE ALTI](https://geoservices.ign.fr/rgealti)** — IGN digital terrain
  model (regular elevation grid), here at 5 m resolution.
- **[iTowns](https://github.com/iTowns/itowns)** — 3D web rendering
  engine (based on three.js) used by the webapp.

## Third parties

- **IGN** — LiDAR HD, RGE ALTI, WMTS (orthophotos, IGN map)
- **[Camptocamp](https://www.camptocamp.org/)** — points of interest, topo guide,
  search
- **[PoissonRecon](https://github.com/mkazhdan/PoissonRecon)** — surface
  reconstruction from the point cloud
- Inspiration for terrain generation / normals computation + base architecture
  of the C++ builder:
  [OscarPilote/LidarTerrainMesh](https://github.com/oscarpilote/LidarTerrainMesh)
- **OpenTOpoMap** Additional map layer

Full dependency details:
[NOTICE.md](NOTICE.md).

## Note

[Claude](https://claude.ai) is used for the implementation.


## TODO

- Better CI and tests
- Update install scripts (`project.toml` / `environment.yml` are out of date.)
- Enrich the database (LiDAR HD coverage)

## How to build tiles?

Terrain is built with a small GUI:

```
python alpineview_builder/gui/main.py
```

1. Draw a rectangle on the map ("Select rect" button) to choose the
   zone to build.
2. Check the paths (`builder`/`coarse` executables, RGE ALTI folder,
   output folder) and the options (`processes`, `force rebuild`).
3. Click "Build". The GUI chains: fine reconstruction (LiDAR HD),
   coarse reconstruction (RGE ALTI), then tileset assembly
   (`ogc3d_tiler`).


--> `terrainPack.json` gets updated along with the .glb files.

## Build workflow

```
   LiDAR HD (.laz)              RGE ALTI 5 m (.asc)
         |                            |
         v                            v
   alpineview_builder          alpineview_coarse
   (Poisson Recon + cleanup / simplification / cropping)
         \                            /
          \                          /
           v                        v
              .glb tiles (position only)
                        |
                        v
              ogc3d_tiler/build_tileset.py
                        |
                        v
              a single file: tileset + subtrees
              (webapp/src/terrainPack.json)
```

**Coordinate system.** The whole pipeline works in a single frame:
a Mercator projection centered on the Alps (metric, no distortion over the
covered area), the same tiling scheme as the WebMercatorQuad grid used by
the IGN imagery tiles.

**Altitude.** Tile Z stays in NGF69 (the raw altitude from the source
files) end to end.

**Tile naming.**
The terrain is first split into tiles of about 190km2 (Zoom 11 Pseudo-Mercator).

Inside, one subfolder per level of detail, then one file per tile:

The level of details are relative to the Pseudo-Mercator level 11.

```
public/pm/
└── 1024.700/            <- cell (x.y at CELL_LEVEL)
    ├── 0/0.0.glb
    └── 1/0.0.glb  1.0.glb  0.1.glb  1.1.glb
```

**Poisson Recon and post-processing.** For the LiDAR HD zone: point
cloud → implicit surface reconstruction (PoissonRecon) → keep the main
connected component → simplification ("Quadratic Error Metric simplification")
→ crop to the tile's exact boundaries.

**RGE ALTI 5 m vs point cloud.** Beyond a certain level of detail (Zoom 15),
using the point cloud's precision is pointless, it's faster to use the
RGE ALTI 5m data.

**The 3D Tiles tileset.** `ogc3d_tiler/build_tileset.py`

I more or less follow the standard:
https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc

With the difference that everything is written into a single .json file,
committed directly to the repo.


## Webapp workflow

```
  terrainPack.json
         |
         v
  3D Tiles tiles (.glb) loaded on the fly by iTowns based on camera placement
         |
         v
  Fetches the WMTS tile matching the zoom level
         |
         v
  UVs computed for each vertex
         |
         v
  Normals computed and a "skirt" added to avoid holes in the mesh.
```

**Coordinate system.** Pseudo Mercator, metric

**Note** UVs and normals are recomputed dynamically to minimize the size of
requests to cloud storage.
