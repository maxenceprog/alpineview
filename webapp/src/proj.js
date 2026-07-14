import proj4 from "proj4";

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 " +
    "+x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs"
);

export const l93ToWgs84 = proj4("EPSG:2154", "EPSG:4326");
export const wgs84ToL93 = proj4("EPSG:4326", "EPSG:2154");

proj4.defs(
  "EPSG:3857",
  "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 " +
    "+units=m +nadgrids=@null +wktext +no_defs"
);

export const l93ToWebMercator = proj4("EPSG:2154", "EPSG:3857");
export const webMercatorToL93 = proj4("EPSG:3857", "EPSG:2154");
