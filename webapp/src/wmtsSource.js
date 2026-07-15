import * as itowns from "itowns";
import * as THREE from "three";
import { fetchWmtsCanvas, wmtsLevelRange } from "./wmts.js";

const CRS = "EPSG:2154";

export class WmtsStitchSource extends itowns.Source {
  constructor({ sourceKey, extent }) {
    super({ url: "https://data.geopf.fr/wmts", crs: CRS, extent });
    this.sourceKey = sourceKey;
    this.zoom = wmtsLevelRange(sourceKey, extent.planarDimensions().x);
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max
      && this.extent.intersectsExtent(extent);
  }

  // `tile` is a Tile (zoom/row/col) of the view's own quadtree, not an Extent.
  async loadData(tile) {
    const canvas = await fetchWmtsCanvas(tile.toExtent(CRS), this.sourceKey);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // iTowns derives the UV pitch in tile space, assuming the texture covers this tile
    // exactly — hence the exact-extent canvas, and the tile itself as the extent.
    texture.extent = tile;
    return texture;
  }
}
