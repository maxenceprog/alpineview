import json
import struct
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = Path.home() / "github/alpineview/webapp/public/terrain"


@dataclass
class ImplicitTilingSubtree:
    tile_path_format: str
    max_level: int


class BitStream:
    def __init__(self):
        self.__bytes_array = bytearray()
        self.__cur_byte = 0
        self.__cur_byte_length = 0

    def append_bit(self, bit: bool):
        self.__cur_byte |= int(bit) << self.__cur_byte_length
        self.__cur_byte_length += 1

        if self.__cur_byte_length == 8:
            self.__bytes_array.append(self.__cur_byte)
            self.__cur_byte = 0
            self.__cur_byte_length = 0

    def finish(self):
        if self.__cur_byte_length > 0:
            self.__bytes_array.append(self.__cur_byte)
            self.__cur_byte = 0
            self.__cur_byte_length = 0

    @property
    def content(self) -> bytes:
        return bytes(self.__bytes_array)


def glb_height_range(path: Path):
    with open(path, "rb") as f:
        header = f.read(20)

        if header[:4] != b"glTF":
            return None

        json_length = struct.unpack("<I", header[12:16])[0]
        document = json.loads(f.read(json_length))

    for accessor in document.get("accessors", ()):
        if accessor.get("type") == "VEC3" and "min" in accessor:
            return accessor["min"][2], accessor["max"][2]

    return None


def compact1by1(value: int) -> int:
    """
    Decode one coordinate from Morton order.
    """
    result = 0
    bit = 0

    while value:
        result |= (value & 1) << bit
        value >>= 2
        bit += 1

    return result


def demorton(level: int, subtree: ImplicitTilingSubtree):
    size = 1 << level

    for morton in range(size * size):
        x = compact1by1(morton)
        y = compact1by1(morton >> 1)

        yield (level, x, y), DEFAULT_PATH / subtree.tile_path_format.format(
            level=level,
            x=x,
            y=y,
        )
