import maplibregl, { Map as MLMap } from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BBox, RowGroupInfo } from "./parquet.ts";

const SOURCE_ID = "rowgroups";
const FILL_LAYER = "rowgroups-fill";
const LINE_LAYER = "rowgroups-line";

const PALETTE = [
  "#4f8cff",
  "#ff7a59",
  "#27c197",
  "#c97cff",
  "#ffd166",
  "#ef476f",
  "#06d6a0",
  "#118ab2",
  "#f25c54",
  "#8a4fff",
];

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export function createMap(container: HTMLElement): MLMap {
  const map = new maplibregl.Map({
    container,
    style: "https://demotiles.maplibre.org/style.json",
    center: [0, 0],
    zoom: 1,
    renderWorldCopies: false,
    attributionControl: {
      compact: true,
      customAttribution:
        'by <a href="https://spatialty.io" target="_blank" rel="noopener noreferrer">spatialty</a>',
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
  map.addControl(new ProjectionControl(), "top-right");
  return map;
}

const GLOBE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>`;
const MAP_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v16"/><path d="M15 6v16"/></svg>`;

export class ProjectionControl implements maplibregl.IControl {
  private mapRef: MLMap | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private isGlobe = false;

  onAdd(map: MLMap): HTMLElement {
    this.mapRef = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group projection-ctrl";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "projection-ctrl-button";
    button.innerHTML = GLOBE_ICON;
    this.applyLabel(button, false);
    button.addEventListener("click", () => this.toggle());
    container.appendChild(button);
    this.container = container;
    this.button = button;
    return container;
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.mapRef = null;
    this.container = null;
    this.button = null;
  }

  private applyLabel(button: HTMLButtonElement, isGlobe: boolean): void {
    const label = isGlobe ? "Switch to flat (Mercator) view" : "Switch to globe view";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  private toggle(): void {
    if (!this.mapRef || !this.button) return;
    this.isGlobe = !this.isGlobe;
    this.mapRef.setProjection({ type: this.isGlobe ? "globe" : "mercator" });
    this.button.innerHTML = this.isGlobe ? MAP_ICON : GLOBE_ICON;
    this.button.classList.toggle("active", this.isGlobe);
    this.applyLabel(this.button, this.isGlobe);
  }
}

function bboxToPolygon(b: BBox): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [b.xmin, b.ymin],
        [b.xmax, b.ymin],
        [b.xmax, b.ymax],
        [b.xmin, b.ymax],
        [b.xmin, b.ymin],
      ],
    ],
  };
}

export interface RowGroupFeatureProps {
  index: number;
  color: string;
  visible: boolean;
}

export function buildFeatureCollection(
  rowGroups: RowGroupInfo[],
  visibility: Map<number, boolean>,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, RowGroupFeatureProps> {
  const features: GeoJSON.Feature<GeoJSON.Polygon, RowGroupFeatureProps>[] = [];
  for (const rg of rowGroups) {
    if (!rg.bbox) continue;
    features.push({
      type: "Feature",
      id: rg.index,
      geometry: bboxToPolygon(rg.bbox),
      properties: {
        index: rg.index,
        color: colorFor(rg.index),
        visible: visibility.get(rg.index) ?? true,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

export function ensureLayers(map: MLMap, fc: GeoJSON.FeatureCollection) {
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(fc);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data: fc, promoteId: "index" });
  map.addLayer({
    id: FILL_LAYER,
    type: "fill",
    source: SOURCE_ID,
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        0.6,
        ["boolean", ["feature-state", "hovered"], false],
        0.45,
        ["get", "visible"],
        0.12,
        0,
      ],
    },
  });
  map.addLayer({
    id: LINE_LAYER,
    type: "line",
    source: SOURCE_ID,
    paint: {
      "line-color": ["get", "color"],
      "line-width": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        5,
        ["boolean", ["feature-state", "hovered"], false],
        4,
        1.4,
      ],
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        1,
        ["boolean", ["feature-state", "hovered"], false],
        1,
        ["get", "visible"],
        0.9,
        0,
      ],
    },
  });
}

export function updateFeatures(map: MLMap, fc: GeoJSON.FeatureCollection) {
  const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
}

export function onRowGroupClick(
  map: MLMap,
  handler: (indices: number[], lngLat: maplibregl.LngLat) => void,
): void {
  map.on("click", FILL_LAYER, (e) => {
    const features = e.features ?? [];
    const seen = new Set<number>();
    const indices: number[] = [];
    for (const f of features) {
      const props = f.properties as RowGroupFeatureProps | undefined;
      if (!props || props.visible === false) continue;
      if (seen.has(props.index)) continue;
      seen.add(props.index);
      indices.push(props.index);
    }
    if (indices.length === 0) return;
    handler(indices, e.lngLat);
  });
  map.on("mouseenter", FILL_LAYER, () => {
    const canvas = map.getCanvas();
    if (canvas.style.cursor !== "crosshair") canvas.style.cursor = "pointer";
  });
  map.on("mouseleave", FILL_LAYER, () => {
    const canvas = map.getCanvas();
    if (canvas.style.cursor === "pointer") canvas.style.cursor = "";
  });
}

export function onRowGroupHover(map: MLMap, handler: (index: number | null) => void): void {
  let current: number | null = null;
  const update = (next: number | null) => {
    if (next === current) return;
    current = next;
    handler(next);
  };
  map.on("mousemove", FILL_LAYER, (e) => {
    const features = e.features ?? [];
    let pick: number | null = null;
    for (const f of features) {
      const props = f.properties as RowGroupFeatureProps | undefined;
      if (!props || props.visible === false) continue;
      pick = props.index;
      break;
    }
    update(pick);
  });
  map.on("mouseleave", FILL_LAYER, () => update(null));
}

let lastSelected: number | null = null;
export function setSelected(map: MLMap, index: number | null) {
  if (lastSelected !== null) {
    map.setFeatureState({ source: SOURCE_ID, id: lastSelected }, { selected: false });
  }
  if (index !== null) {
    map.setFeatureState({ source: SOURCE_ID, id: index }, { selected: true });
  }
  lastSelected = index;
}

let lastHovered: number | null = null;
export function setHovered(map: MLMap, index: number | null) {
  if (lastHovered !== null && lastHovered !== index) {
    map.setFeatureState({ source: SOURCE_ID, id: lastHovered }, { hovered: false });
  }
  if (index !== null) {
    map.setFeatureState({ source: SOURCE_ID, id: index }, { hovered: true });
  }
  lastHovered = index;
}

export function fitToBBox(map: MLMap, b: BBox, padding = 40) {
  const w = b.xmax - b.xmin;
  const h = b.ymax - b.ymin;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  if (w === 0 && h === 0) {
    map.flyTo({ center: [b.xmin, b.ymin], zoom: 8 });
    return;
  }
  map.fitBounds(
    [
      [b.xmin, b.ymin],
      [b.xmax, b.ymax],
    ],
    { padding, duration: 600, maxZoom: 12 },
  );
}

export function fitToRowGroups(map: MLMap, rowGroups: RowGroupInfo[]) {
  const valid = rowGroups.filter((r) => r.bbox);
  if (valid.length === 0) return;
  let xmin = Infinity,
    ymin = Infinity,
    xmax = -Infinity,
    ymax = -Infinity;
  for (const r of valid) {
    const b = r.bbox!;
    if (b.xmin < xmin) xmin = b.xmin;
    if (b.ymin < ymin) ymin = b.ymin;
    if (b.xmax > xmax) xmax = b.xmax;
    if (b.ymax > ymax) ymax = b.ymax;
  }
  fitToBBox(map, { xmin, ymin, xmax, ymax }, 60);
}

const FILTER_SOURCE = "filter-rect";
const FILTER_FILL = "filter-rect-fill";
const FILTER_LINE = "filter-rect-line";

export function setFilterRect(map: MLMap, bbox: BBox | null) {
  if (bbox === null) {
    if (map.getLayer(FILTER_LINE)) map.removeLayer(FILTER_LINE);
    if (map.getLayer(FILTER_FILL)) map.removeLayer(FILTER_FILL);
    if (map.getSource(FILTER_SOURCE)) map.removeSource(FILTER_SOURCE);
    return;
  }
  const data: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: "Feature",
    geometry: bboxToPolygon(bbox),
    properties: {},
  };
  const src = map.getSource(FILTER_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(FILTER_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: FILTER_FILL,
    type: "fill",
    source: FILTER_SOURCE,
    paint: { "fill-color": "#ef476f", "fill-opacity": 0.05 },
  });
  map.addLayer({
    id: FILTER_LINE,
    type: "line",
    source: FILTER_SOURCE,
    paint: {
      "line-color": "#ef476f",
      "line-width": 2,
      "line-dasharray": [3, 2],
    },
  });
}

const PREVIEW_SOURCE = "draw-preview";
const PREVIEW_FILL = "draw-preview-fill";
const PREVIEW_LINE = "draw-preview-line";

function setPreviewRect(map: MLMap, bbox: BBox | null) {
  if (bbox === null) {
    if (map.getLayer(PREVIEW_LINE)) map.removeLayer(PREVIEW_LINE);
    if (map.getLayer(PREVIEW_FILL)) map.removeLayer(PREVIEW_FILL);
    if (map.getSource(PREVIEW_SOURCE)) map.removeSource(PREVIEW_SOURCE);
    return;
  }
  const data: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: "Feature",
    geometry: bboxToPolygon(bbox),
    properties: {},
  };
  const src = map.getSource(PREVIEW_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(PREVIEW_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: PREVIEW_FILL,
    type: "fill",
    source: PREVIEW_SOURCE,
    paint: { "fill-color": "#4f8cff", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: PREVIEW_LINE,
    type: "line",
    source: PREVIEW_SOURCE,
    paint: { "line-color": "#4f8cff", "line-width": 2 },
  });
}

export interface DrawSession {
  cancel(): void;
}

export function startDrawRectangle(map: MLMap, onComplete: (b: BBox | null) => void): DrawSession {
  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";
  map.dragPan.disable();
  map.boxZoom.disable();
  map.doubleClickZoom.disable();

  let start: { lng: number; lat: number } | null = null;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    canvas.style.cursor = "";
    map.dragPan.enable();
    map.boxZoom.enable();
    map.doubleClickZoom.enable();
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    setPreviewRect(map, null);
  };

  function onDown(e: MapMouseEvent) {
    e.preventDefault();
    start = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  }
  function onMove(e: MapMouseEvent) {
    if (!start) return;
    setPreviewRect(map, makeBBox(start, e.lngLat));
  }
  function onUp(e: MapMouseEvent) {
    if (!start) {
      cleanup();
      onComplete(null);
      return;
    }
    const bbox = makeBBox(start, e.lngLat);
    cleanup();
    if (bbox.xmin === bbox.xmax || bbox.ymin === bbox.ymax) {
      onComplete(null);
    } else {
      onComplete(bbox);
    }
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);

  return {
    cancel: () => {
      cleanup();
      onComplete(null);
    },
  };
}

function makeBBox(a: { lng: number; lat: number }, b: { lng: number; lat: number }): BBox {
  return {
    xmin: Math.min(a.lng, b.lng),
    xmax: Math.max(a.lng, b.lng),
    ymin: Math.min(a.lat, b.lat),
    ymax: Math.max(a.lat, b.lat),
  };
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !(a.xmax < b.xmin || a.xmin > b.xmax || a.ymax < b.ymin || a.ymin > b.ymax);
}
