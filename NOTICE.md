# Notice

© 2026 Maxence Ruyer, all rights reserved

Please ask me, if you want to reuse my code as i didn't define the license modele yet.

## Vendored third-party code

Each keeps its own license text alongside the source.

| Component | Location | License |
|---|---|---|
| [PoissonRecon](https://github.com/mkazhdan/PoissonRecon) | `third-parties/PoissonRecon/` | MIT |
| [Fast-Quadric-Mesh-Simplification](https://github.com/sp4cerat/Fast-Quadric-Mesh-Simplification) | `src/Simplify.h` | MIT |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) | `extern/meshoptimizer/` | MIT |
| [miniply](https://github.com/vilya/miniply) | `extern/miniply/` | MIT |
| [tinyply](https://github.com/ddiakopoulos/tinyply) | `extern/tinyply/` | Public domain |
| [nanoflann](https://github.com/jlblancoc/nanoflann) | `extern/nanoflann/` | BSD-3-Clause |
| [copc-lib](https://github.com/RockRobotic/copc-lib) | `extern/copc-lib/` | BSD |
| [laz-perf](https://github.com/hobuinc/laz-perf) | `extern/laz-perf/` | Apache-2.0 |

Paths are relative to `alpineview_builder/`. Build and Python dependencies are
installed from conda/PyPI, not redistributed here (`environment.yml`,
`pyproject.toml`).

## Bundled in the web client

| Component | Copyright | License |
|---|---|---|
| [iTowns](https://github.com/iTowns/itowns) | © IGN | CECILL-B OR MIT (used under MIT) |
| [three.js](https://github.com/mrdoob/three.js) | © 2010-2025 three.js authors | MIT |
| [Draco](https://github.com/google/draco) decoder | © 2016 The Draco Authors | Apache-2.0 |
| [proj4js](https://github.com/proj4js/proj4js) | © 2014 Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral, Calvin Metcalf | MIT |
| [Leaflet](https://github.com/Leaflet/Leaflet) | © 2010-2023 Volodymyr Agafonkin | BSD-2-Clause |
| [SunCalc](https://github.com/mourner/suncalc) | © 2014 Volodymyr Agafonkin | BSD-2-Clause |
| [DOMPurify](https://github.com/cure53/DOMPurify) | © Dr.-Ing. Mario Heiderich, Cure53 | MPL-2.0 OR Apache-2.0 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | © 2014 Vitaly Puzrin, Alex Kocharin | MIT |
| [Color Thief](https://github.com/lokesh/color-thief) | © 2015 Lokesh Dhakar | MIT |
| [tilebelt](https://github.com/mapbox/tilebelt) | © 2014 Morgan Herlocker | MIT |
| [socket.io-client](https://github.com/socketio/socket.io) | © 2014-present Guillermo Rauch and Socket.IO contributors | MIT |

## LidarTerrainMesh

`alpineview_builder` derives from
[LidarTerrainMesh](https://github.com/oscarpilote/LidarTerrainMesh)

Big thanks to the author !

## CGAL

`alpineview_builder` links CGAL's `estimate_scale`, `scanline_orient_normals`
and `Monge_via_jet_fitting` — **GPL-3.0-or-later**, not CGAL's LGPL core. No
builder binary is distributed, so nothing is triggered today, but any future
license for `alpineview_builder` must account for it.

## Data

- **IGN** LiDAR HD, BD TOPO, BD ORTHO, Plan IGN — © IGN,
  [Licence Ouverte 2.0 (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
  Free reuse including commercial, on condition of crediting the source and its
  update date. The generated tiles are derivative works and inherit this.
- **[Camptocamp.org](https://www.camptocamp.org/articles/106728/fr/licences-des-contenus)** —
  waypoint and topoguide data CC BY-SA; images licensed per image by their
  authors, not uniformly CC BY-SA.