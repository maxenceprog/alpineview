// Bill-of-materials: "x.y" per built 1 km cell (see scripts/update_bill_of_materials.py).
// Lets per-cell fetches be skipped for cells known not to have been built, instead of
// paying for a request that just 404s.
// null (missing/unreachable file, e.g. a dev server that hasn't run the script) means
// "unknown" — permissive, never treated as "nothing built".
export async function loadBom(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const text = await res.text();
    return new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export function bomHas(bom, ox, oy) {
  return !bom || bom.has(`${ox}.${oy}`);
}
