#!/usr/bin/env python3
"""Filter one terrain .drc tile and write the result to stdout as a .drc.

Runs the "remesh" pipeline being tuned in the compare_tile debug script:
quadric decimation (fast_simplification, agg=4), flip isolated back-facing
triangles, then a Taubin smoothing pass. Used by the dev server's
/debug/filter route to preview a smoothed tile in the webapp without touching
the file on disk.

    python scripts/filter_tile.py TX TY Z [--ratio R] [--tiles DIR] > out.drc
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import DracoPy
import fast_simplification
import numpy as np
import open3d as o3d

# Debug preview: smoothing flattens height variation below one quantization
# step, so 14 bits posterizes into visible terraces. Over-quantize (16+) to
# push the step below visibility. (Original tiles ship at 14.)
QUANTIZATION_BITS = 14
COMPRESSION_LEVEL = 1


def load(path: Path) -> o3d.geometry.TriangleMesh:
    d = DracoPy.decode(path.read_bytes())
    m = o3d.geometry.TriangleMesh()
    m.vertices = o3d.utility.Vector3dVector(np.asarray(d.points, np.float64))
    m.triangles = o3d.utility.Vector3iVector(np.asarray(d.faces, np.int32))
    return m


EDGE_EPS = 1e-3


def boundary_mask(p: np.ndarray) -> np.ndarray:
    """Vertices on the tile's outer x/y edge — these are shared with the
    neighbouring (unfiltered) tile and must not move, or the tiles pull apart
    and leave a visible seam along the boundary."""
    mn, mx = p[:, :2].min(0), p[:, :2].max(0)
    ex = (mx - mn) * EDGE_EPS + 1e-7
    return (
        (p[:, 0] <= mn[0] + ex[0])
        | (p[:, 0] >= mx[0] - ex[0])
        | (p[:, 1] <= mn[1] + ex[1])
        | (p[:, 1] >= mx[1] - ex[1])
    )


def clamp_outliers(
    mesh: o3d.geometry.TriangleMesh, k: float = 4.0, floor_m: float = 1.0
) -> o3d.geometry.TriangleMesh:
    """Robust height (z) despiking: for each vertex, compare its z to the median
    of its 1-ring neighbours; if it deviates by more than k * MAD (median abs
    deviation, floored at `floor_m` metres) it's an outlier and gets clamped to
    that neighbour median. Keeps vertex count / faces intact so the mesh stays
    re-encodable. Coords are km here, so metres are scaled by 1e-3."""
    p = np.asarray(mesh.vertices).copy()
    faces = np.asarray(mesh.triangles)
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.vstack([e, e[:, ::-1]])  # both directions: full 1-ring per vertex
    order = np.argsort(e[:, 0], kind="stable")
    src, nbr_z = e[order, 0], p[e[order, 1], 2]
    bounds = np.searchsorted(src, np.arange(len(p) + 1))

    z = p[:, 2]
    med = z.copy()
    mad = np.zeros(len(p))
    for i in range(len(p)):
        a, b = bounds[i], bounds[i + 1]
        if b > a:
            zz = nbr_z[a:b]
            med[i] = np.median(zz)
            mad[i] = np.median(np.abs(zz - med[i]))

    thr = k * np.maximum(mad, floor_m * 1e-3)
    out = np.abs(z - med) > thr
    p[out, 2] = med[out]
    mesh.vertices = o3d.utility.Vector3dVector(p)
    print(f"clamped {int(out.sum())} outlier vertices", file=sys.stderr)
    return mesh


def pin_boundary(
    out: o3d.geometry.TriangleMesh, p0: np.ndarray
) -> o3d.geometry.TriangleMesh:
    """Restore the tile's edge vertices to their original positions so it still
    lines up with its unfiltered neighbours. Only valid when the filter kept
    vertex count/order (smoothing, not decimation)."""
    q = np.asarray(out.vertices)
    if len(q) != len(p0):
        print("skip boundary pin (vertex count changed)", file=sys.stderr)
        return out
    pin = boundary_mask(p0)
    q[pin] = p0[pin]
    out.vertices = o3d.utility.Vector3dVector(q)
    return out


def remove_skirt(
    mesh: o3d.geometry.TriangleMesh, drop_m: float = 50.0
) -> o3d.geometry.TriangleMesh:
    """Drop the vertical border skirt (a ~`drop_m` metre wall extruded straight
    down from the tile edge). A skirt wall triangle has all three vertices on
    the tile boundary and spans a big vertical drop; real surface triangles at
    the border are near-flat and always reach an interior vertex. Removing the
    triangles (not the vertices) leaves the surface untouched — the bottom-ring
    vertices are then unreferenced and pruned. Coords are km (metres = 1e-3)."""
    p = np.asarray(mesh.vertices)
    t = np.asarray(mesh.triangles)
    edge = boundary_mask(p)
    span_m = (p[t, 2].max(1) - p[t, 2].min(1)) * 1000.0
    skirt = edge[t].all(1) & (span_m > 0.5 * drop_m)
    mesh.triangles = o3d.utility.Vector3iVector(t[~skirt])
    mesh.remove_unreferenced_vertices()
    print(f"removed {int(skirt.sum())} skirt triangles", file=sys.stderr)
    return mesh


def _vkey(P: np.ndarray) -> np.ndarray:
    """Position hash for exact set membership (bit pattern of rounded coords)."""
    q = np.ascontiguousarray(np.round(P, 7))
    return q.view(np.dtype((np.void, q.dtype.itemsize * q.shape[1]))).ravel()


def restitch_boundary(
    p1: np.ndarray, t1: np.ndarray, orig_b: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Re-insert every original boundary vertex that fast_simplification dropped,
    so the tile's boundary ring is bit-identical to the original (and therefore
    watertight against neighbours meshed to the same ring). fast_simplify keeps
    corners and ~98% of the border exactly; this only fixes the handful it moved.
    Each missing vert lies on a tile-edge line inside exactly one simplified
    boundary edge; split that edge's triangle into a fan (winding preserved)."""
    mn, mx = p1[:, :2].min(0), p1[:, :2].max(0)
    ex = (mx - mn) * EDGE_EPS + 1e-7
    missing = orig_b[~np.isin(_vkey(orig_b), _vkey(p1))]
    if len(missing) == 0:
        return p1, t1

    # directed edges (winding order) + opposite third vertex + owning triangle;
    # a boundary edge is one used by a single triangle (1-D hash for speed).
    e_uv = np.concatenate([t1[:, [0, 1]], t1[:, [1, 2]], t1[:, [2, 0]]])
    e_w = np.concatenate([t1[:, 2], t1[:, 0], t1[:, 1]])
    e_ti = np.tile(np.arange(len(t1)), 3)
    lo_i = np.minimum(e_uv[:, 0], e_uv[:, 1]).astype(np.int64)
    hi_i = np.maximum(e_uv[:, 0], e_uv[:, 1]).astype(np.int64)
    _, idx, cnt = np.unique(
        lo_i * len(p1) + hi_i, return_index=True, return_counts=True
    )
    b = idx[cnt == 1]
    bu, bv, bw, bti = e_uv[b, 0], e_uv[b, 1], e_w[b], e_ti[b]
    Pu, Pv = p1[bu], p1[bv]

    kill: set[int] = set()
    new_tris: list[tuple[int, int, int]] = []
    new_pts = list(p1)
    for ax, val in ((0, mn[0]), (0, mx[0]), (1, mn[1]), (1, mx[1])):
        var = 1 - ax
        on = (np.abs(Pu[:, ax] - val) <= ex[ax]) & (np.abs(Pv[:, ax] - val) <= ex[ax])
        mline = missing[np.abs(missing[:, ax] - val) <= ex[ax]]
        if not on.any() or len(mline) == 0:
            continue
        eu, ev, ew, eti = bu[on], bv[on], bw[on], bti[on]
        u_v, v_v = Pu[on, var], Pv[on, var]
        lo, hi = np.minimum(u_v, v_v), np.maximum(u_v, v_v)
        order = np.argsort(lo)  # boundary edges tile the line left→right
        lo_s, hi_s = lo[order], hi[order]
        mv = mline[:, var]
        j = np.clip(np.searchsorted(lo_s, mv, side="right") - 1, 0, len(lo_s) - 1)
        ok = (mv >= lo_s[j] - 1e-9) & (mv <= hi_s[j] + 1e-9)

        by_edge: dict[int, list[np.ndarray]] = {}
        for k in np.where(ok)[0]:
            by_edge.setdefault(int(order[j[k]]), []).append(mline[k])
        for ei, verts in by_edge.items():
            a, c, w = int(eu[ei]), int(ev[ei]), int(ew[ei])
            verts = sorted(
                verts, key=lambda pt: pt[var], reverse=bool(v_v[ei] <= u_v[ei])
            )
            chain = [a]
            for vpos in verts:
                chain.append(len(new_pts))
                new_pts.append(vpos)
            chain.append(c)
            for s, e in zip(chain[:-1], chain[1:]):
                new_tris.append((s, e, w))  # fan from w keeps winding
            kill.add(int(eti[ei]))

    keep = np.ones(len(t1), bool)
    keep[list(kill)] = False
    t2 = np.vstack([t1[keep], np.array(new_tris, np.int32)]) if new_tris else t1[keep]
    print(f"restitched {len(missing)} boundary verts", file=sys.stderr)
    return np.array(new_pts, np.float64), t2


def filter_mesh(
    mesh: o3d.geometry.TriangleMesh, ratio: float
) -> o3d.geometry.TriangleMesh:
    mesh = remove_skirt(mesh)
    p = np.asarray(mesh.vertices)
    t = np.asarray(mesh.triangles)
    orig_b = p[boundary_mask(p)].copy()
    p1, t1 = fast_simplification.simplify(p, t, target_reduction=0.9, agg=1)
    p2, t2 = restitch_boundary(
        np.asarray(p1, np.float64), np.asarray(t1, np.int32), orig_b
    )
    out = o3d.geometry.TriangleMesh()
    out.vertices = o3d.utility.Vector3dVector(p2)
    out.triangles = o3d.utility.Vector3iVector(t2)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tx", type=int)
    ap.add_argument("ty", type=int)
    ap.add_argument("z", type=int)
    ap.add_argument("--tiles", default="webapp/public/tiles")
    ap.add_argument("--ratio", type=float, default=0.5)
    args = ap.parse_args()

    path = Path(args.tiles) / f"tile.{args.tx}.{args.ty}.{args.z}.drc"
    if not path.exists():
        print(f"missing: {path}", file=sys.stderr)
        sys.exit(1)

    mesh = filter_mesh(load(path), args.ratio)
    encoded = DracoPy.encode(
        np.asarray(mesh.vertices),
        faces=np.asarray(mesh.triangles).astype(np.uint32),
        quantization_bits=QUANTIZATION_BITS,
        compression_level=COMPRESSION_LEVEL,
    )
    print(
        f"{path.name}: {len(mesh.vertices)} verts -> {len(encoded)} bytes",
        file=sys.stderr,
    )
    sys.stdout.buffer.write(encoded)


if __name__ == "__main__":
    main()
