import json
import struct
from pathlib import Path

from tiler_io import (
    BitStream,
    ImplicitTilingSubtree,
    demorton,
)


def align8(data: bytes, align_byte=b"\x00") -> bytes:
    size = (-len(data)) & 7
    return data + align_byte * size


def build_availability_buffers(subtree: ImplicitTilingSubtree):

    content = set()

    for level in range(subtree.max_level):
        for key, path in demorton(level, subtree):
            if path.exists():
                content.add(key)

    tiles = set()

    for key in content:
        level, x, y = key

        while (level, x, y) not in tiles:
            tiles.add((level, x, y))

            if level == 0:
                break

            level, x, y = level - 1, x // 2, y // 2

    tile_availability = BitStream()
    content_availability = BitStream()

    for level in range(subtree.max_level):
        for key, _ in demorton(level, subtree):
            tile_availability.append_bit(key in tiles)
            content_availability.append_bit(key in content)

    tile_availability.finish()
    content_availability.finish()

    return tile_availability.content, content_availability.content


def write_subtree(
    subtree,
    output: Path,
):

    output.parent.mkdir(exist_ok=True, parents=True)

    tile_bytes, content_bytes = build_availability_buffers(subtree)

    tile_view = align8(tile_bytes)
    buffer_bytes = tile_view + content_bytes

    #
    # subtree JSON
    #
    subtree_json = {
        "buffers": [{"byteLength": len(buffer_bytes)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(tile_bytes)},
            {
                "buffer": 0,
                "byteOffset": len(tile_view),
                "byteLength": len(content_bytes),
            },
        ],
        "tileAvailability": {"bitstream": 0},
        "contentAvailability": [{"bitstream": 1}],
        "childSubtreeAvailability": {"constant": 0},
    }

    json_chunk = json.dumps(
        subtree_json,
        separators=(",", ":"),
    ).encode("utf-8")

    json_chunk = align8(json_chunk, b" ")
    binary_chunk = align8(buffer_bytes)
    #
    # subtree file header
    #
    with output.open("wb") as f:
        # Magic: "subt" (0x74627573 little-endian)
        f.write(struct.pack("<I", 0x74627573))

        # Version
        f.write(struct.pack("<I", 1))

        # JSON chunk length (uint64)
        f.write(struct.pack("<Q", len(json_chunk)))

        # Binary chunk length (uint64)
        f.write(struct.pack("<Q", len(binary_chunk)))

        # Chunks
        f.write(json_chunk)
        f.write(binary_chunk)
