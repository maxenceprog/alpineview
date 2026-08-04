import { describe, it, expect, vi } from "vitest";
import { fetchCellPois, fetchWaypointDetail, imageUrl, resolveEmbeddedImages } from "../src/camptocampApi.js";

describe("fetchCellPois", () => {
  it("GETs the Camptocamp waypoints endpoint with the cell's bbox and keeps only titled docs", async () => {
    const documents = [
      {
        document_id: 1,
        waypoint_type: "summit",
        locales: [{ lang: "fr", title: "Barre des Écrins" }],
        geometry: { geom: JSON.stringify({ type: "Point", coordinates: [708945, 5610203] }) },
      },
      { document_id: 2, waypoint_type: "summit", locales: [] }, // no title → dropped
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ documents, total: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pois = await fetchCellPois(965, 6430);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("https://api.camptocamp.org/waypoints?bbox=");
    expect(url).toContain("wtyp=summit,pass,hut,access");
    expect(url).toContain("pl=fr");

    expect(pois).toHaveLength(1);
    expect(pois[0].locales[0].title).toBe("Barre des Écrins");

    vi.unstubAllGlobals();
  });

  it("throws when the API responds with a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 504 }));
    await expect(fetchCellPois(965, 6430)).rejects.toThrow(/504/);
    vi.unstubAllGlobals();
  });

  it("paginates past the API's 100-result page cap instead of truncating", async () => {
    const makeDoc = (id) => ({
      document_id: id,
      waypoint_type: "summit",
      locales: [{ lang: "fr", title: `Peak ${id}` }],
      geometry: { geom: JSON.stringify({ type: "Point", coordinates: [0, 0] }) },
    });
    const page1 = Array.from({ length: 100 }, (_, i) => makeDoc(i));
    const page2 = Array.from({ length: 30 }, (_, i) => makeDoc(100 + i));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: page1, total: 130 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: page2, total: 130 }) });
    vi.stubGlobal("fetch", fetchMock);

    const pois = await fetchCellPois(965, 6430);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=0");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=100");
    expect(pois).toHaveLength(130);

    vi.unstubAllGlobals();
  });
});

describe("fetchWaypointDetail", () => {
  it("GETs the single-waypoint endpoint by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ document_id: 42 }) });
    vi.stubGlobal("fetch", fetchMock);

    const doc = await fetchWaypointDetail(42);

    expect(fetchMock).toHaveBeenCalledWith("https://api.camptocamp.org/waypoints/42?l=fr");
    expect(doc.document_id).toBe(42);

    vi.unstubAllGlobals();
  });
});

describe("imageUrl", () => {
  it("inserts the size code before the file extension", () => {
    expect(imageUrl("1738753921_2009206138.jpg")).toBe(
      "https://media.camptocamp.org/c2corg-active/1738753921_2009206138MI.jpg"
    );
    expect(imageUrl("1738753921_2009206138.jpg", "SI")).toBe(
      "https://media.camptocamp.org/c2corg-active/1738753921_2009206138SI.jpg"
    );
  });
});

describe("resolveEmbeddedImages", () => {
  it("replaces [img=id align]caption[/img] tags with resolved markdown images", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ filename: "1738753921_2009206138.jpg" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const raw = "Intro.\n\n[img=128880 right]Cirque de Bonne Pierre[/img] some text.";
    const out = await resolveEmbeddedImages(raw);

    expect(fetchMock).toHaveBeenCalledWith("https://api.camptocamp.org/images/128880?l=fr");
    expect(out).toContain(
      "![Cirque de Bonne Pierre](https://media.camptocamp.org/c2corg-active/1738753921_2009206138MI.jpg)"
    );
    expect(out).not.toContain("[img=");

    vi.unstubAllGlobals();
  });

  it("handles multi-word modifiers after the image id (e.g. 'big central')", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ filename: "1738753921_2009206138.jpg" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await resolveEmbeddedImages("[img=224158 big central]Du Col des Écrins au Dôme de Neige[/img]");

    expect(fetchMock).toHaveBeenCalledWith("https://api.camptocamp.org/images/224158?l=fr");
    expect(out).toContain("![Du Col des Écrins au Dôme de Neige]");
    expect(out).not.toContain("[img=");

    vi.unstubAllGlobals();
  });

  it("dedupes repeated image ids into a single fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ filename: "a.jpg" }) });
    vi.stubGlobal("fetch", fetchMock);

    await resolveEmbeddedImages("[img=1]A[/img] [img=1]A again[/img]");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("falls back to the caption text when an image fails to resolve", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const out = await resolveEmbeddedImages("[img=999]Missing photo[/img]");

    expect(out).toBe("Missing photo");
    vi.unstubAllGlobals();
  });

  it("returns the input unchanged when there are no image tags", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await resolveEmbeddedImages("Just plain text.");

    expect(out).toBe("Just plain text.");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
