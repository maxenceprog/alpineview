import json

from subtree_writer import write_subtree
from tiler_io import DEFAULT_PATH, ImplicitTilingSubtree, glb_height_range

TERRAIN = DEFAULT_PATH

SIZE = 16000

HEIGHT_MIN = 0
HEIGHT_MAX = 5000

HEIGHT_MARGIN = 10

WORLD_CENTER_X = 1_000_000
WORLD_CENTER_Y = 6_500_000
WORLD_HALF_SIZE = 500_000

CELL_GEOMETRIC_ERROR = 512

MAX_LEVEL = 7


def tile_origin(tile_name):

    x_km, y_km = map(int, tile_name.split("."))

    return (
        x_km * 1000,
        y_km * 1000,
    )


def make_box(z_min, z_max):

    return [
        SIZE / 2,
        SIZE / 2,
        (z_max + z_min) / 2,
        SIZE / 2,
        0,
        0,
        0,
        SIZE / 2,
        0,
        0,
        0,
        (z_max - z_min) / 2,
    ]


def cell_height_range(tile_dir):

    z_min, z_max = HEIGHT_MAX, HEIGHT_MIN

    for level_dir in tile_dir.iterdir():
        if not level_dir.is_dir() or not level_dir.name.isdigit():
            continue

        for glb in level_dir.glob("*.glb"):
            found = glb_height_range(glb)

            if found is None:
                continue

            z_min = min(z_min, found[0])
            z_max = max(z_max, found[1])

    if z_min > z_max:
        return HEIGHT_MIN, HEIGHT_MAX

    return z_min - HEIGHT_MARGIN, z_max + HEIGHT_MARGIN


def cell_level_count(tile_dir):

    levels = [
        int(path.name)
        for path in tile_dir.iterdir()
        if path.is_dir() and path.name.isdigit() and any(path.glob("*.glb"))
    ]

    if not levels:
        return 0

    return min(max(levels) + 1, MAX_LEVEL)


def make_world_box(root_x, root_y, z_min, z_max):

    return [
        root_x + SIZE / 2,
        root_y + SIZE / 2,
        (z_max + z_min) / 2,
        SIZE / 2,
        0,
        0,
        0,
        SIZE / 2,
        0,
        0,
        0,
        (z_max - z_min) / 2,
    ]


def make_transform(root_x, root_y):

    return [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        root_x,
        root_y,
        0,
        1,
    ]


def build_child_tileset(tile_dir, level_count, height_range):

    root_x, root_y = tile_origin(tile_dir.name)

    tileset = {
        "asset": {
            "version": "1.1",
            "gltfUpAxis": "z",
        },
        "geometricError": CELL_GEOMETRIC_ERROR,
        "root": {
            "boundingVolume": {"box": make_box(*height_range)},
            "transform": make_transform(root_x, root_y),
            "geometricError": CELL_GEOMETRIC_ERROR,
            "refine": "REPLACE",
            "content": {"uri": "{level}/{x}.{y}.glb"},
            "implicitTiling": {
                "subdivisionScheme": "QUADTREE",
                "subtreeLevels": level_count,
                "availableLevels": level_count,
                "subtrees": {"uri": "subtrees/{level}.{x}.{y}.subtree"},
            },
        },
    }

    (tile_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))


def build_child_subtree(tile_dir, level_count):

    subtree = ImplicitTilingSubtree(
        tile_path_format=(f"{tile_dir.name}/{{level}}/{{x}}.{{y}}.glb"),
        max_level=level_count,
    )

    subtree_dir = tile_dir / "subtrees"

    subtree_dir.mkdir(exist_ok=True)

    write_subtree(subtree, subtree_dir / "0.0.0.subtree")


def build_global_tileset(cells):

    children = []

    for tile_dir, height_range in cells:
        root_x, root_y = tile_origin(tile_dir.name)

        children.append(
            {
                "boundingVolume": {
                    "box": make_world_box(
                        root_x,
                        root_y,
                        *height_range,
                    )
                },
                "geometricError": CELL_GEOMETRIC_ERROR,
                "refine": "REPLACE",
                "content": {"uri": f"{tile_dir.name}/tileset.json"},
            }
        )

    tileset = {
        "asset": {
            "version": "1.1",
            "gltfUpAxis": "z",
        },
        "geometricError": 1000,
        "root": {
            "boundingVolume": {
                "box": [
                    WORLD_CENTER_X,
                    WORLD_CENTER_Y,
                    (HEIGHT_MAX + HEIGHT_MIN) / 2,
                    WORLD_HALF_SIZE,
                    0,
                    0,
                    0,
                    WORLD_HALF_SIZE,
                    0,
                    0,
                    0,
                    (HEIGHT_MAX - HEIGHT_MIN) / 2,
                ]
            },
            "geometricError": 1000,
            "refine": "REPLACE",
            "children": children,
        },
    }

    (TERRAIN / "tileset.json").write_text(json.dumps(tileset, indent=2))


def is_tile_directory(path):

    if not path.is_dir():
        return False

    try:
        a, b = path.name.split(".")
        int(a)
        int(b)
        return True

    except Exception:
        return False


def main():

    tile_dirs = sorted([p for p in TERRAIN.iterdir() if is_tile_directory(p)])

    built = []

    for tile_dir in tile_dirs:
        level_count = cell_level_count(tile_dir)

        if level_count == 0:
            print("skipping", tile_dir.name, "(no glb)")
            continue

        height_range = cell_height_range(tile_dir)

        print(
            "building",
            tile_dir.name,
            "levels 0..%d" % (level_count - 1),
            "z %d..%d" % height_range,
        )

        build_child_tileset(tile_dir, level_count, height_range)

        build_child_subtree(tile_dir, level_count)

        built.append((tile_dir, height_range))

    build_global_tileset(built)

    print("done", len(built), "tilesets")


if __name__ == "__main__":
    main()
