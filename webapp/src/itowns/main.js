import * as itowns from "itowns";
import { DracoTileLayer } from "./dracoLayer.js";

itowns.CRS.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

const extent = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const viewerDiv = document.getElementById("viewerDiv");
const params = new URLSearchParams(location.search);
const x = 1000 * (parseFloat(params.get("x")) || 965.5);
const y = 1000 * (parseFloat(params.get("y")) || 6430.5);

const view = new itowns.PlanarView(viewerDiv, extent, {
  maxSubdivisionLevel: 12,
  placement: {
    coord: new itowns.Coordinates("EPSG:2154", x, y),
    range: 8000,
    tilt: 25,
    heading: 0,
  },
});

const orthoSource = new itowns.WMSSource({
  url: "https://data.geopf.fr/wms-r/wms",
  name: "ORTHOIMAGERY.ORTHOPHOTOS",
  crs: "EPSG:2154",
  extent,
  version: "1.3.0",
  format: "image/jpeg",
});
view.addLayer(new itowns.ColorLayer("ortho", { source: orthoSource }));

const demSource = new itowns.WMSSource({
  url: "https://data.geopf.fr/wms-r/wms",
  name: "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
  crs: "EPSG:2154",
  extent,
  version: "1.3.0",
  width: 256,
  format: "image/x-bil;bits=32",
});
view.addLayer(
  new itowns.ElevationLayer("dem", {
    source: demSource,
    noDataValue: -99999,
    clampValues: { min: 0 },
  }),
);

view.addLayer(new DracoTileLayer("draco", view));
