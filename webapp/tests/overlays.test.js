import { describe, it, expect } from "vitest";
import { cellLazStem } from "../src/overlays.js";

describe("cellLazStem", () => {
  it("maps a cell (x0,y0) to its NW-corner LAZ stem (y = y0+1)", () => {
    expect(cellLazStem(965, 6430)).toBe("LHD_FXX_0965_6431_PTS_LAMB93_IGN69");
  });
  it("zero-pads to 4 digits", () => {
    expect(cellLazStem(932, 6437)).toBe("LHD_FXX_0932_6438_PTS_LAMB93_IGN69");
  });
});
