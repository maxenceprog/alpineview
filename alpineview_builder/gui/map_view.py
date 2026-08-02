"""Pure-Qt map widget: no browser, no JS. A QGraphicsView shows a raster
basemap (IGN PLANIGNV2 over WMTS, standard Web Mercator XYZ tiles) at one of
three zoom levels (9-11), auto-picked from the widget's on-screen size so the
Alps roughly fill it, and adjustable with the wheel. Only tiles inside the
current viewport are fetched, cached to disk per (z, x, y) so repeat runs hit
disk instead of the network. Rect/tile/built overlays and the drag-to-select
rectangle are QGraphicsRectItems driven by native Qt mouse events.
"""

import math
import os
import threading

import requests
from qtpy.QtCore import QPointF, QRectF, Qt, Signal
from qtpy.QtGui import QBrush, QColor, QPen, QPixmap
from qtpy.QtWidgets import QGraphicsRectItem, QGraphicsScene, QGraphicsView
from tqdm import tqdm

CENTER = {"lon": 6.6, "lat": 45.0}
MIN_ZOOM = 9
MAX_ZOOM = 11
TILE_PX = 256
# French Alps, west/south/east/north in lon/lat.
ALPS_BBOX = (5.0, 43.8, 7.7, 46.5)
TILE_URL = (
    "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
    "&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image%2Fpng"
    "&TILEMATRIXSET=PM_0_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"
)
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "alpineview-gui-tiles")


def lonlat_to_world(lon, lat, z):
    """Web Mercator pixel coords at zoom z, standard XYZ tile scheme."""
    n = 2**z
    x = (lon + 180.0) / 360.0 * n * TILE_PX
    lat_rad = math.radians(lat)
    y = (
        (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi)
        / 2.0
        * n
        * TILE_PX
    )
    return x, y


def world_to_lonlat(x, y, z):
    n = 2**z
    lon = x / (n * TILE_PX) * 360.0 - 180.0
    y_frac = y / (n * TILE_PX)
    lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * y_frac)))
    return lon, math.degrees(lat_rad)


def _bbox_tile_range(bbox, z):
    west, south, east, north = bbox
    x0, y0 = lonlat_to_world(west, north, z)
    x1, y1 = lonlat_to_world(east, south, z)
    n = 2**z
    return (
        max(0, int(x0 // TILE_PX)),
        min(n - 1, int(x1 // TILE_PX)),
        max(0, int(y0 // TILE_PX)),
        min(n - 1, int(y1 // TILE_PX)),
    )


def _best_fit_zoom(bbox, view_w, view_h):
    """Highest zoom level in [MIN_ZOOM, MAX_ZOOM] whose rendering of bbox
    still fits inside a view_w x view_h viewport."""
    west, south, east, north = bbox
    best = MIN_ZOOM
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x0, y0 = lonlat_to_world(west, north, z)
        x1, y1 = lonlat_to_world(east, south, z)
        if (x1 - x0) <= view_w and (y1 - y0) <= view_h:
            best = z
    return best


def _rect_item(color, fill=None):
    item = QGraphicsRectItem()
    item.setPen(QPen(QColor(color), 2))
    if fill:
        item.setBrush(QBrush(QColor(fill)))
    item.setZValue(10)
    return item


class MapView(QGraphicsView):
    rect_selected = Signal(float, float, float, float)
    _tile_ready = Signal(int, int, int, bytes)

    def __init__(self, parent=None):
        super().__init__(parent)
        # setSceneRect() below (like most view setup) can trigger
        # scrollContentsBy() synchronously, which reaches _load_visible_tiles()
        # -- so every attribute it touches must exist before setScene/setSceneRect.
        self.select_mode = False
        self._drag_start = None
        self._select_item = None
        self.zoom = MIN_ZOOM
        self._tile_items = {}  # (z, x, y) -> QGraphicsPixmapItem
        self._loading = set()  # (z, x, y) reserved, fetch in flight
        self._last_range = None  # (zoom, x0, x1, y0, y1) last loaded, skip repeats
        self._session = requests.Session()

        self._tile_ready.connect(self._place_tile)
        self.setScene(QGraphicsScene(self))
        # itemsBoundingRect-based auto sceneRect shrinks to ~nothing the
        # instant a zoom change clears all tile pixmaps, which then clamps
        # the very next centerOn() back near the origin -- pin it explicitly
        # instead. Using the Alps bbox (rather than the whole world) also
        # caps how far panning/scrollbars can go, so the view can't scroll
        # off into tiles outside the built range.
        self._set_scene_rect_for_zoom()
        self.setDragMode(QGraphicsView.ScrollHandDrag)

        cx, cy = lonlat_to_world(CENTER["lon"], CENTER["lat"], self.zoom)
        self.centerOn(cx, cy)

        self._rect_overlay_items = []
        self._tiles_overlay_items = []
        self._built_overlay_items = []

    # -- basemap tiles --------------------------------------------------

    def showEvent(self, event):
        super().showEvent(event)
        self._fit_initial_zoom()
        self._load_visible_tiles()

    def _fit_initial_zoom(self):
        size = self.viewport().size()
        self.zoom = _best_fit_zoom(ALPS_BBOX, size.width(), size.height())
        self._set_scene_rect_for_zoom()
        cx, cy = lonlat_to_world(CENTER["lon"], CENTER["lat"], self.zoom)
        self.centerOn(cx, cy)

    def _set_scene_rect_for_zoom(self):
        x0, x1, y0, y1 = _bbox_tile_range(ALPS_BBOX, self.zoom)
        self.scene().setSceneRect(
            x0 * TILE_PX, y0 * TILE_PX, (x1 - x0 + 1) * TILE_PX, (y1 - y0 + 1) * TILE_PX
        )

    def _visible_tile_range(self):
        bx0, bx1, by0, by1 = _bbox_tile_range(ALPS_BBOX, self.zoom)
        rect = self.mapToScene(self.viewport().rect()).boundingRect()
        x0 = max(bx0, int(rect.left() // TILE_PX))
        x1 = min(bx1, int(rect.right() // TILE_PX))
        y0 = max(by0, int(rect.top() // TILE_PX))
        y1 = min(by1, int(rect.bottom() // TILE_PX))
        return x0, x1, y0, y1

    def _load_visible_tiles(self):
        x0, x1, y0, y1 = self._visible_tile_range()
        current_range = (self.zoom, x0, x1, y0, y1)
        if current_range == self._last_range:
            return
        self._last_range = current_range
        wanted = [
            (self.zoom, tx, ty) for tx in range(x0, x1 + 1) for ty in range(y0, y1 + 1)
        ]
        missing = [
            k for k in wanted if k not in self._tile_items and k not in self._loading
        ]
        for key in missing:
            self._loading.add(key)
        if missing:
            threading.Thread(
                target=self._fetch_tiles, args=(missing,), daemon=True
            ).start()

    def _fetch_tiles(self, keys):
        os.makedirs(CACHE_DIR, exist_ok=True)
        zoom = keys[0][0]
        for z, tx, ty in tqdm(
            keys, desc="basemap tiles z=%d" % zoom, disable=len(keys) < 2
        ):
            path = os.path.join(CACHE_DIR, "%d_%d_%d.png" % (z, tx, ty))
            if os.path.exists(path):
                with open(path, "rb") as f:
                    self._tile_ready.emit(z, tx, ty, f.read())
                continue
            url = TILE_URL.format(z=z, x=tx, y=ty)
            try:
                resp = self._session.get(url, timeout=10)
                resp.raise_for_status()
                data = resp.content
            except requests.RequestException:
                continue
            with open(path, "wb") as f:
                f.write(data)
            self._tile_ready.emit(z, tx, ty, data)

    def _place_tile(self, z, tx, ty, data):
        key = (z, tx, ty)
        self._loading.discard(key)
        if z != self.zoom:
            return  # zoom changed since the fetch started, no longer wanted
        pm = QPixmap()
        if not pm.loadFromData(data):
            return
        item = self.scene().addPixmap(pm)
        item.setPos(tx * TILE_PX, ty * TILE_PX)
        item.setZValue(0)
        self._tile_items[key] = item

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._load_visible_tiles()

    def scrollContentsBy(self, dx, dy):
        super().scrollContentsBy(dx, dy)
        self._load_visible_tiles()

    def wheelEvent(self, event):
        delta = event.angleDelta().y() or event.pixelDelta().y()
        if delta == 0:
            event.accept()
            return
        new_zoom = max(MIN_ZOOM, min(MAX_ZOOM, self.zoom + (1 if delta > 0 else -1)))
        event.accept()
        if new_zoom == self.zoom:
            return
        center = self.mapToScene(self.viewport().rect().center())
        lon, lat = world_to_lonlat(center.x(), center.y(), self.zoom)
        for item in self._tile_items.values():
            self.scene().removeItem(item)
        self._tile_items.clear()
        self.zoom = new_zoom
        self._set_scene_rect_for_zoom()
        cx, cy = lonlat_to_world(lon, lat, self.zoom)
        self.centerOn(cx, cy)
        self._redraw_overlays()
        self._load_visible_tiles()

    # -- selection --------------------------------------------------

    def set_select_mode(self, on):
        self.select_mode = bool(on)
        self.setDragMode(
            QGraphicsView.NoDrag if self.select_mode else QGraphicsView.ScrollHandDrag
        )

    def mousePressEvent(self, event):
        if self.select_mode and event.button() == Qt.LeftButton:
            self._drag_start = self.mapToScene(event.pos())
            if self._select_item is None:
                self._select_item = _rect_item("#4c78a8", "#4c78a826")
                self._select_item.setZValue(20)
                self.scene().addItem(self._select_item)
            self._select_item.setRect(QRectF(self._drag_start, self._drag_start))
            self._select_item.show()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self.select_mode and self._drag_start is not None:
            cur = self.mapToScene(event.pos())
            self._select_item.setRect(QRectF(self._drag_start, cur).normalized())
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if (
            self.select_mode
            and self._drag_start is not None
            and event.button() == Qt.LeftButton
        ):
            cur = self.mapToScene(event.pos())
            r = QRectF(self._drag_start, cur).normalized()
            self._drag_start = None
            self._select_item.hide()
            lon0, lat0 = world_to_lonlat(r.left(), r.bottom(), self.zoom)
            lon1, lat1 = world_to_lonlat(r.right(), r.top(), self.zoom)
            self.rect_selected.emit(lon0, lat0, lon1, lat1)
            return
        super().mouseReleaseEvent(event)

    # -- overlays --------------------------------------------------

    def _box_to_scene_rect(self, west, south, east, north):
        x0, y0 = lonlat_to_world(west, north, self.zoom)
        x1, y1 = lonlat_to_world(east, south, self.zoom)
        return QRectF(QPointF(x0, y0), QPointF(x1, y1))

    def draw_rects(self, boxes):
        self._rect_boxes = list(boxes)
        self._redraw_box_group(
            self._rect_overlay_items, self._rect_boxes, "#e45756", fill="#e4575626"
        )

    def draw_tiles(self, boxes):
        self._tiles_boxes = list(boxes)
        self._redraw_box_group(self._tiles_overlay_items, self._tiles_boxes, "#4c78a8")

    def draw_built(self, boxes):
        self._built_boxes = list(boxes)
        self._redraw_box_group(
            self._built_overlay_items, self._built_boxes, "#54a24b", fill="#54a24b73"
        )

    def _redraw_box_group(self, items, boxes, color, fill=None):
        for item in items:
            self.scene().removeItem(item)
        items.clear()
        for box in boxes:
            item = _rect_item(color, fill)
            item.setRect(self._box_to_scene_rect(*box))
            self.scene().addItem(item)
            items.append(item)

    def _redraw_overlays(self):
        self._redraw_box_group(
            self._rect_overlay_items,
            getattr(self, "_rect_boxes", []),
            "#e45756",
            fill="#e4575626",
        )
        self._redraw_box_group(
            self._tiles_overlay_items, getattr(self, "_tiles_boxes", []), "#4c78a8"
        )
        self._redraw_box_group(
            self._built_overlay_items,
            getattr(self, "_built_boxes", []),
            "#54a24b",
            fill="#54a24b73",
        )
