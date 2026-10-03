import maplibregl, { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BBox } from "./parquet.ts";

const SOURCE_ID = "rowgroups";
const FILL_LAYER = "rowgroups-fill";
const LINE_LAYER = "rowgroups-line";
const PAGE_SOURCE_ID = "page-bboxes";
const PAGE_FILL_LAYER = "page-bboxes-fill";
const PAGE_HALO_LAYER = "page-bboxes-halo";
const PAGE_LINE_LAYER = "page-bboxes-line";
const PAGE_COLOR = "#ffea00";

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
    style: {
      version: 8,
      sources: {
        "raster-tiles": {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        },
      },
      layers: [
        {
          id: "osm-tiles",
          type: "raster",
          source: "raster-tiles",
        },
      ],
    },
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
  map.addControl(new TileBoundariesControl(true), "top-right");
  return map;
}

const GLOBE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>`;
const MAP_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v16"/><path d="M15 6v16"/></svg>`;
const GRID_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>`;

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

export class TileBoundariesControl implements maplibregl.IControl {
  private mapRef: MLMap | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private enabled: boolean;

  constructor(initialEnabled = false) {
    this.enabled = initialEnabled;
  }

  onAdd(map: MLMap): HTMLElement {
    this.mapRef = map;
    map.showTileBoundaries = this.enabled;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group projection-ctrl";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "projection-ctrl-button";
    button.innerHTML = GRID_ICON;
    button.classList.toggle("active", this.enabled);
    this.applyLabel(button, this.enabled);
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

  private applyLabel(button: HTMLButtonElement, enabled: boolean): void {
    const label = enabled ? "Hide tile boundaries" : "Show tile boundaries";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  private toggle(): void {
    if (!this.mapRef || !this.button) return;
    this.enabled = !this.enabled;
    this.mapRef.showTileBoundaries = this.enabled;
    this.button.classList.toggle("active", this.enabled);
    this.applyLabel(this.button, this.enabled);
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

export type RowGroupState = "active" | "hit" | "dim" | "hidden";

export interface RowGroupFeature {
  index: number;
  /** Longitude/latitude bbox. */
  bbox: BBox;
  color: string;
  state: RowGroupState;
}

export interface RowGroupFeatureProps {
  index: number;
  color: string;
  state: RowGroupState;
}

export function buildFeatureCollection(
  items: RowGroupFeature[],
): GeoJSON.FeatureCollection<GeoJSON.Polygon, RowGroupFeatureProps> {
  return {
    type: "FeatureCollection",
    // Draw coarse row groups last so they stay on top of finer, smaller ones.
    features: items
      .filter((item) => item.state !== "hidden")
      .reverse()
      .map((item) => ({
        type: "Feature",
        id: item.index,
        geometry: bboxToPolygon(item.bbox),
        properties: { index: item.index, color: item.color, state: item.state },
      })),
  };
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
        0.55,
        ["boolean", ["feature-state", "hovered"], false],
        0.45,
        ["match", ["get", "state"], "hit", 0.3, "active", 0.1, 0.02],
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
        ["match", ["get", "state"], "hit", 2.2, 1.2],
      ],
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        1,
        ["boolean", ["feature-state", "hovered"], false],
        1,
        ["match", ["get", "state"], "dim", 0.2, 0.9],
      ],
    },
  });
}

export function updateFeatures(map: MLMap, fc: GeoJSON.FeatureCollection) {
  const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
}

export function setPageBboxes(map: MLMap, bboxes: BBox[]) {
  if (bboxes.length === 0) {
    if (map.getLayer(PAGE_LINE_LAYER)) map.removeLayer(PAGE_LINE_LAYER);
    if (map.getLayer(PAGE_HALO_LAYER)) map.removeLayer(PAGE_HALO_LAYER);
    if (map.getLayer(PAGE_FILL_LAYER)) map.removeLayer(PAGE_FILL_LAYER);
    if (map.getSource(PAGE_SOURCE_ID)) map.removeSource(PAGE_SOURCE_ID);
    return;
  }
  const data: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
    type: "FeatureCollection",
    features: bboxes.map((bbox, pageIndex) => ({
      type: "Feature",
      id: pageIndex,
      geometry: bboxToPolygon(bbox),
      properties: { pageIndex },
    })),
  };
  const source = map.getSource(PAGE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(PAGE_SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: PAGE_FILL_LAYER,
    type: "fill",
    source: PAGE_SOURCE_ID,
    paint: { "fill-color": PAGE_COLOR, "fill-opacity": 0.14 },
  });
  map.addLayer({
    id: PAGE_HALO_LAYER,
    type: "line",
    source: PAGE_SOURCE_ID,
    paint: {
      "line-color": "#111827",
      "line-width": 6,
      "line-opacity": 0.85,
    },
  });
  map.addLayer({
    id: PAGE_LINE_LAYER,
    type: "line",
    source: PAGE_SOURCE_ID,
    paint: {
      "line-color": PAGE_COLOR,
      "line-width": 3,
      "line-opacity": 1,
      "line-dasharray": [2, 1],
    },
  });
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
      if (!props || props.state === "dim") continue;
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
      if (!props || props.state === "dim") continue;
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

