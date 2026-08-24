"""unit test: compute_missing and compute_max_level against fake tile sets."""

from alpineview_builder.scripts.verify_hd_tiles import (
    compute_max_level,
    compute_missing,
)


def demo():
    cloud = {(0, 0), (1, 1), (2, 2)}
    existing = {(0, 0)}
    assert compute_missing(cloud, existing) == {(1, 1), (2, 2)}

    level_sets = {
        5: {(2, 2)},
        6: {(4, 4)},
        7: set(),
        8: set(),
    }
    assert compute_max_level(1, 1, level_sets) == 6

    level_sets_none = {5: set(), 6: set(), 7: set(), 8: set()}
    assert compute_max_level(3, 3, level_sets_none) == 4

    print("OK")


if __name__ == "__main__":
    demo()
