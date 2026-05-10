import "./style.css";
import {
  bboxesIntersect,
  buildFeatureCollection,
  colorFor,
  createMap,
  ensureLayers,
  fitToBBox,
  fitToRowGroups,
  onRowGroupClick,
  onRowGroupHover,
  setFilterRect,
  setHovered,
  setSelected,
  startDrawRectangle,
  updateFeatures,
} from "./map.ts";
import { formatBBox, formatBytes, loadFromFile, loadFromUrl } from "./parquet.ts";
import type { BBox, ColumnStats, GeoParquetInfo, RowGroupInfo } from "./parquet.ts";
import { FILTER_OPS, makeId, rowGroupMatchesFilters } from "./filter.ts";
import type { ColumnFilter, FilterOp } from "./filter.ts";
import maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import type { DrawSession } from "./map.ts";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

app.innerHTML = `
  <header class="toolbar">
    <h1>GeoParquet RowGroup BBox Viewer</h1>
    <input
      id="url"
      type="text"
      placeholder="https://example.com/data.parquet"
      autocomplete="off"
      spellcheck="false"
    />
    <button id="load-url" class="primary" type="button">Load URL</button>
    <label class="file">
      Open file
      <input id="file" type="file" accept=".parquet,.geoparquet,application/octet-stream" hidden />
    </label>
    <span id="status" class="status">Open a GeoParquet file to begin.</span>
  </header>
  <main>
    <div id="map"></div>
  </main>
  <section class="bottom">
    <div class="file-stats" id="file-stats" hidden></div>
    <div class="controls">
      <button id="show-all" type="button">Show all</button>
      <button id="hide-all" type="button">Hide all</button>
      <span class="sep" aria-hidden="true"></span>
      <div id="filter-list" class="filter-list"></div>
      <button id="draw-filter" type="button">+ Rect</button>
      <button id="add-col-filter" type="button">+ Filter</button>
      <span id="filter-info" class="match" hidden></span>
      <button id="clear-sel" type="button" hidden class="clear-sel">Clear selection</button>
    </div>
    <div class="panes" id="panes">
      <div class="pane">
        <div class="table-wrap">
          <div id="empty-rg" class="empty">Open a GeoParquet file to begin.</div>
          <table class="rg" id="rg-table" hidden>
            <thead>
              <tr>
                <th><input type="checkbox" id="toggle-all" checked title="Toggle all" /></th>
                <th>#</th>
                <th>Rows</th>
                <th>Compressed</th>
                <th>Uncompressed</th>
                <th>Offset</th>
                <th>BBox source</th>
                <th>BBox (xmin, ymin, xmax, ymax)</th>
                <th>Geom types</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="pane" id="col-pane" hidden>
        <div class="pane-header" id="col-pane-header"></div>
        <div class="table-wrap">
          <div id="empty-col" class="empty" hidden>No column metadata for this row group.</div>
          <table class="rg" id="col-table" hidden>
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Codec</th>
                <th>Values</th>
                <th>Nulls</th>
                <th>Distinct</th>
                <th>Compressed</th>
                <th>Uncompressed</th>
                <th>Min</th>
                <th>Max</th>
                <th>Geo bbox</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
  <div class="drop-overlay" id="drop-overlay" hidden>
    <div class="drop-overlay-inner">Drop GeoParquet file to open</div>
  </div>
`;

const mapContainer = document.querySelector<HTMLDivElement>("#map")!;
const map: MLMap = createMap(mapContainer);

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const loadUrlBtn = document.querySelector<HTMLButtonElement>("#load-url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const rgTable = document.querySelector<HTMLTableElement>("#rg-table")!;
const rgTbody = rgTable.querySelector("tbody")!;
const rgEmpty = document.querySelector<HTMLDivElement>("#empty-rg")!;
const colTable = document.querySelector<HTMLTableElement>("#col-table")!;
const colTbody = colTable.querySelector("tbody")!;
const colEmpty = document.querySelector<HTMLDivElement>("#empty-col")!;
const colHeader = document.querySelector<HTMLDivElement>("#col-pane-header")!;
const colPane = document.querySelector<HTMLDivElement>("#col-pane")!;
const toggleAllEl = document.querySelector<HTMLInputElement>("#toggle-all")!;
const showAllBtn = document.querySelector<HTMLButtonElement>("#show-all")!;
const hideAllBtn = document.querySelector<HTMLButtonElement>("#hide-all")!;
const drawFilterBtn = document.querySelector<HTMLButtonElement>("#draw-filter")!;
const filterInfo = document.querySelector<HTMLSpanElement>("#filter-info")!;
const clearSelBtn = document.querySelector<HTMLButtonElement>("#clear-sel")!;
const filterList = document.querySelector<HTMLDivElement>("#filter-list")!;
const addColFilterBtn = document.querySelector<HTMLButtonElement>("#add-col-filter")!;
const fileStatsEl = document.querySelector<HTMLDivElement>("#file-stats")!;
const dropOverlay = document.querySelector<HTMLDivElement>("#drop-overlay")!;

let current: GeoParquetInfo | null = null;
let selectedIndex: number | null = null;
let filterRect: BBox | null = null;
let drawSession: DrawSession | null = null;
let suppressMapClick = false;
const visibility = new Map<number, boolean>();
let columnFilters: ColumnFilter[] = [];
let candidatePopup: maplibregl.Popup | null = null;

function setStatus(msg: string, kind: "info" | "error" = "info") {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", kind === "error");
}

function setBusy(busy: boolean) {
  loadUrlBtn.disabled = busy;
  fileInput.disabled = busy;
}

async function handleUrl() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Enter a URL first.", "error");
    return;
  }
  setBusy(true);
  setStatus(`Loading metadata from ${url}…`);
  try {
    const info = await loadFromUrl(url);
    onLoaded(info, url);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load: ${formatError(err)}`, "error");
  } finally {
    setBusy(false);
  }
}

async function handleFile(file: File) {
  setBusy(true);
  setStatus(`Reading ${file.name}…`);
  try {
    const info = await loadFromFile(file);
    onLoaded(info, file.name);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to read ${file.name}: ${formatError(err)}`, "error");
  } finally {
    setBusy(false);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function onLoaded(info: GeoParquetInfo, label: string) {
  cancelDraw();
  closeCandidatePopup();
  setFilter(null);
  columnFilters = [];
  renderFilters();
  current = info;
  selectedIndex = null;
  visibility.clear();
  for (const rg of info.rowGroups) visibility.set(rg.index, true);
  toggleAllEl.checked = true;
  toggleAllEl.indeterminate = false;
  clearSelBtn.hidden = true;
  renderFileStats(info, label);
  renderRowGroupTable(info);
  renderColumnTable(null);
  renderMap();
  setSelected(map, null);
  fitToRowGroups(map, info.rowGroups);
  const warnSuffix = info.warnings.length ? ` · ${info.warnings.length} warning(s)` : "";
  setStatus(`Loaded ${label}${warnSuffix}.`);
}

function renderFileStats(info: GeoParquetInfo, label: string) {
  const totalRows = info.rowGroups.reduce((s, r) => s + r.numRows, 0);
  const compressed = info.rowGroups.reduce((s, r) => s + r.totalCompressedBytes, 0);
  const uncompressed = info.rowGroups.reduce((s, r) => s + r.totalUncompressedBytes, 0);
  const ratio = compressed > 0 ? uncompressed / compressed : 0;
  const columnCount = info.rowGroups[0]?.columns.length ?? 0;

  const stats: Array<[string, string, string?]> = [
    ["Source", label, label],
    ["File size", info.fileSize !== null ? formatBytes(info.fileSize) : "—"],
    ["Row groups", info.rowGroups.length.toLocaleString()],
    ["Rows", totalRows.toLocaleString()],
    ["Columns", columnCount.toLocaleString()],
    ["Compressed", `${formatBytes(compressed)}${ratio > 0 ? ` (${ratio.toFixed(2)}× ratio)` : ""}`],
    ["Uncompressed", formatBytes(uncompressed)],
  ];
  if (info.geoVersion) stats.push(["GeoParquet", info.geoVersion]);
  if (info.primaryColumn) stats.push(["Geometry", info.primaryColumn]);
  if (info.crs) stats.push(["CRS", info.crs]);

  fileStatsEl.innerHTML = "";
  for (const [k, v, title] of stats) {
    const item = document.createElement("div");
    item.className = "stat";
    const key = document.createElement("span");
    key.className = "stat-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "stat-val";
    val.textContent = v;
    if (title) val.title = title;
    item.append(key, val);
    fileStatsEl.appendChild(item);
  }
  fileStatsEl.hidden = false;
}

function visibleRowGroups(info: GeoParquetInfo): RowGroupInfo[] {
  return info.rowGroups.filter((rg) => {
    if (filterRect && !(rg.bbox && bboxesIntersect(rg.bbox, filterRect))) return false;
    if (columnFilters.length && !rowGroupMatchesFilters(rg, columnFilters)) return false;
    return true;
  });
}

function availableColumnPaths(): string[] {
  if (!current) return [];
  const seen = new Set<string>();
  for (const rg of current.rowGroups) {
    for (const c of rg.columns) seen.add(c.path);
  }
  return [...seen].sort();
}

function renderFilters() {
  filterList.innerHTML = "";
  if (filterRect) filterList.appendChild(buildSpatialChip(filterRect));
  for (const f of columnFilters) {
    filterList.appendChild(buildFilterRow(f));
  }
  updateMatchInfo();
}

function buildSpatialChip(rect: BBox): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "filter-chip spatial";
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = "rect";
  const value = document.createElement("span");
  value.className = "chip-value mono";
  value.textContent = formatBBox(rect);
  value.title = formatBBox(rect);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = "Clear spatial filter";
  remove.addEventListener("click", () => setFilter(null));
  wrap.append(label, value, remove);
  return wrap;
}

function buildFilterRow(f: ColumnFilter): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "filter-chip col-filter";
  wrap.dataset.id = f.id;

  const colSel = document.createElement("select");
  colSel.title = "Column";
  for (const path of availableColumnPaths()) {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path;
    if (path === f.column) opt.selected = true;
    colSel.appendChild(opt);
  }

  const opSel = document.createElement("select");
  opSel.title = "Operator";
  for (const op of FILTER_OPS) {
    const opt = document.createElement("option");
    opt.value = op.value;
    opt.textContent = op.label;
    if (op.value === f.op) opt.selected = true;
    opSel.appendChild(opt);
  }

  const v1 = document.createElement("input");
  v1.type = "text";
  v1.placeholder = "value";
  v1.value = f.value;
  v1.size = 12;

  const v2 = document.createElement("input");
  v2.type = "text";
  v2.placeholder = "and";
  v2.value = f.value2;
  v2.size = 8;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = "Remove filter";

  const syncValueInputs = () => {
    const def = FILTER_OPS.find((o) => o.value === (opSel.value as FilterOp));
    const need = def?.needsValue ?? 0;
    v1.hidden = need < 1;
    v2.hidden = need < 2;
  };
  syncValueInputs();

  colSel.addEventListener("change", () => {
    f.column = colSel.value;
    scheduleApply();
  });
  opSel.addEventListener("change", () => {
    f.op = opSel.value as FilterOp;
    syncValueInputs();
    scheduleApply();
  });
  v1.addEventListener("input", () => {
    f.value = v1.value;
    scheduleApply();
  });
  v2.addEventListener("input", () => {
    f.value2 = v2.value;
    scheduleApply();
  });
  remove.addEventListener("click", () => {
    columnFilters = columnFilters.filter((x) => x.id !== f.id);
    renderFilters();
    scheduleApply();
  });

  wrap.append(colSel, opSel, v1, v2, remove);
  return wrap;
}

function addColumnFilter() {
  if (!current) {
    setStatus("Load a file before adding filters.", "error");
    return;
  }
  const paths = availableColumnPaths();
  if (paths.length === 0) return;
  const f: ColumnFilter = {
    id: makeId(),
    column: paths[0],
    op: "eq",
    value: "",
    value2: "",
  };
  columnFilters.push(f);
  renderFilters();
  applyColumnFilters();
}

let applyScheduled = false;
function scheduleApply() {
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => {
    applyScheduled = false;
    applyColumnFilters();
  });
}

function applyColumnFilters() {
  if (!current) return;
  closeCandidatePopup();
  // Drop selection if it no longer matches.
  if (selectedIndex !== null) {
    const rg = current.rowGroups.find((r) => r.index === selectedIndex);
    if (!rg || !visibleRowGroups(current).some((v) => v.index === rg.index)) {
      clearSelection();
    }
  }
  renderRowGroupTable(current);
  renderMap();
  updateMatchInfo();
}

function updateMatchInfo() {
  if (!current) {
    filterInfo.hidden = true;
    return;
  }
  const total = current.rowGroups.length;
  const matched = visibleRowGroups(current).length;
  const filterActive = filterRect !== null || columnFilters.length > 0;
  if (!filterActive) {
    filterInfo.hidden = true;
    return;
  }
  filterInfo.hidden = false;
  filterInfo.textContent = `${matched.toLocaleString()} / ${total.toLocaleString()} match`;
}

function renderRowGroupTable(info: GeoParquetInfo) {
  rgTbody.innerHTML = "";
  if (info.rowGroups.length === 0) {
    rgTable.hidden = true;
    rgEmpty.hidden = false;
    rgEmpty.textContent = "No row groups found.";
    return;
  }
  const rows = visibleRowGroups(info);
  if (rows.length === 0) {
    rgTable.hidden = true;
    rgEmpty.hidden = false;
    rgEmpty.textContent = "No row groups match the current filter.";
    return;
  }
  rgTable.hidden = false;
  rgEmpty.hidden = true;

  for (const rg of rows) {
    const tr = document.createElement("tr");
    tr.dataset.index = String(rg.index);

    const tdToggle = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = visibility.get(rg.index) ?? true;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      visibility.set(rg.index, cb.checked);
      renderMap();
      syncToggleAll();
    });
    tdToggle.appendChild(cb);

    const tdIndex = document.createElement("td");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colorFor(rg.index);
    tdIndex.appendChild(swatch);
    tdIndex.append(String(rg.index));

    const tdRows = document.createElement("td");
    tdRows.className = "num";
    tdRows.textContent = rg.numRows.toLocaleString();

    const tdCompressed = document.createElement("td");
    tdCompressed.className = "num";
    tdCompressed.textContent = formatBytes(rg.totalCompressedBytes);

    const tdUncompressed = document.createElement("td");
    tdUncompressed.className = "num muted";
    tdUncompressed.textContent = formatBytes(rg.totalUncompressedBytes);

    const tdOffset = document.createElement("td");
    tdOffset.className = "num mono";
    tdOffset.textContent = rg.fileOffset !== null ? rg.fileOffset.toLocaleString() : "—";

    const tdSource = document.createElement("td");
    tdSource.className = "muted";
    tdSource.textContent = rg.bboxSource;

    const tdBBox = document.createElement("td");
    tdBBox.className = "bbox";
    tdBBox.textContent = rg.bbox ? formatBBox(rg.bbox) : "—";
    if (!rg.bbox) tdBBox.title = "bbox unavailable for this row group";

    const tdGeoTypes = document.createElement("td");
    tdGeoTypes.className = "muted";
    tdGeoTypes.textContent = rg.geometryTypes?.length ? rg.geometryTypes.join(", ") : "—";

    tr.append(
      tdToggle,
      tdIndex,
      tdRows,
      tdCompressed,
      tdUncompressed,
      tdOffset,
      tdSource,
      tdBBox,
      tdGeoTypes,
    );

    tr.addEventListener("click", () => {
      onRowSelect(rg);
    });
    tr.addEventListener("mouseenter", () => {
      if (rg.bbox) setHovered(map, rg.index);
    });
    tr.addEventListener("mouseleave", () => {
      setHovered(map, null);
    });

    rgTbody.appendChild(tr);
  }
  syncToggleAll();
}

function renderColumnTable(rg: RowGroupInfo | null) {
  colTbody.innerHTML = "";
  if (!rg) {
    colPane.hidden = true;
    colTable.hidden = true;
    colEmpty.hidden = true;
    colHeader.textContent = "";
    return;
  }
  colPane.hidden = false;
  colHeader.textContent = `Row group #${rg.index} · ${rg.columns.length} column${rg.columns.length === 1 ? "" : "s"}`;
  if (rg.columns.length === 0) {
    colTable.hidden = true;
    colEmpty.hidden = false;
    return;
  }
  colTable.hidden = false;
  colEmpty.hidden = true;

  for (const col of rg.columns) {
    colTbody.appendChild(buildColumnRow(col));
  }
}

function buildColumnRow(col: ColumnStats): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const tdPath = document.createElement("td");
  tdPath.className = "mono";
  tdPath.style.color = "var(--fg)";
  tdPath.textContent = col.path;

  const tdType = document.createElement("td");
  tdType.className = "muted";
  tdType.textContent = col.type;

  const tdCodec = document.createElement("td");
  tdCodec.className = "muted";
  tdCodec.textContent = col.codec;

  const tdValues = document.createElement("td");
  tdValues.className = "num";
  tdValues.textContent = col.numValues.toLocaleString();

  const tdNulls = document.createElement("td");
  tdNulls.className = "num";
  tdNulls.textContent = col.nullCount !== null ? col.nullCount.toLocaleString() : "—";

  const tdDistinct = document.createElement("td");
  tdDistinct.className = "num muted";
  tdDistinct.textContent = col.distinctCount !== null ? col.distinctCount.toLocaleString() : "—";

  const tdCompressed = document.createElement("td");
  tdCompressed.className = "num";
  tdCompressed.textContent = formatBytes(col.compressedBytes);

  const tdUncompressed = document.createElement("td");
  tdUncompressed.className = "num muted";
  tdUncompressed.textContent = formatBytes(col.uncompressedBytes);

  const tdMin = document.createElement("td");
  tdMin.className = "mono";
  tdMin.textContent = col.min ?? "—";
  if (col.min) tdMin.title = col.min;

  const tdMax = document.createElement("td");
  tdMax.className = "mono";
  tdMax.textContent = col.max ?? "—";
  if (col.max) tdMax.title = col.max;

  const tdGeo = document.createElement("td");
  tdGeo.className = "bbox";
  if (col.geoBbox) {
    tdGeo.textContent = formatBBox(col.geoBbox);
    if (col.geoTypes?.length) {
      tdGeo.title = `geometry_types: ${col.geoTypes.join(", ")}`;
    }
  } else {
    tdGeo.textContent = "—";
  }

  tr.append(
    tdPath,
    tdType,
    tdCodec,
    tdValues,
    tdNulls,
    tdDistinct,
    tdCompressed,
    tdUncompressed,
    tdMin,
    tdMax,
    tdGeo,
  );
  return tr;
}

function onRowSelect(rg: RowGroupInfo, options: { fit?: boolean } = { fit: true }) {
  if (!current) return;
  if (selectedIndex === rg.index) {
    clearSelection();
    return;
  }
  selectedIndex = rg.index;
  for (const tr of rgTbody.querySelectorAll<HTMLTableRowElement>("tr")) {
    tr.classList.toggle("selected", tr.dataset.index === String(rg.index));
  }
  setSelected(map, rg.bbox ? rg.index : null);
  renderColumnTable(rg);
  if (rg.bbox && options.fit !== false) fitToBBox(map, rg.bbox);
  clearSelBtn.hidden = false;
}

function clearSelection() {
  selectedIndex = null;
  for (const tr of rgTbody.querySelectorAll<HTMLTableRowElement>("tr")) {
    tr.classList.remove("selected");
  }
  setSelected(map, null);
  renderColumnTable(null);
  clearSelBtn.hidden = true;
}

function closeCandidatePopup() {
  setHovered(map, null);
  candidatePopup?.remove();
  candidatePopup = null;
}

function showCandidatePopup(lngLat: maplibregl.LngLat, indices: number[]) {
  if (!current) return;
  closeCandidatePopup();
  const candidates: RowGroupInfo[] = [];
  for (const i of indices) {
    const rg = current.rowGroups.find((r) => r.index === i);
    if (rg) candidates.push(rg);
  }
  candidates.sort((a, b) => a.index - b.index);
  if (candidates.length === 0) return;

  const container = document.createElement("div");
  container.className = "candidate-popup";

  const title = document.createElement("div");
  title.className = "candidate-title";
  title.textContent =
    candidates.length === 1
      ? `Row group #${candidates[0].index}`
      : `${candidates.length} candidates`;
  container.appendChild(title);

  const list = document.createElement("div");
  list.className = "candidate-list";
  for (const rg of candidates) list.appendChild(buildCandidateItem(rg));
  container.appendChild(list);

  candidatePopup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    maxWidth: "340px",
    className: "candidate",
  })
    .setLngLat(lngLat)
    .setDOMContent(container)
    .addTo(map);
  candidatePopup.on("close", () => {
    candidatePopup = null;
  });
}

function buildCandidateItem(rg: RowGroupInfo): HTMLElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "candidate-item";
  if (selectedIndex === rg.index) item.classList.add("selected");

  const head = document.createElement("div");
  head.className = "candidate-head";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = colorFor(rg.index);
  head.appendChild(swatch);
  const idx = document.createElement("span");
  idx.className = "candidate-index";
  idx.textContent = `#${rg.index}`;
  head.appendChild(idx);
  const rows = document.createElement("span");
  rows.className = "candidate-rows muted";
  rows.textContent = `${rg.numRows.toLocaleString()} rows`;
  head.appendChild(rows);
  item.appendChild(head);

  const meta = document.createElement("dl");
  meta.className = "candidate-meta";
  appendMeta(meta, "Compressed", formatBytes(rg.totalCompressedBytes));
  appendMeta(meta, "Uncompressed", formatBytes(rg.totalUncompressedBytes));
  appendMeta(meta, "Offset", rg.fileOffset !== null ? rg.fileOffset.toLocaleString() : "—");
  appendMeta(meta, "BBox source", rg.bboxSource);
  appendMeta(meta, "BBox", rg.bbox ? formatBBox(rg.bbox) : "—", true);
  appendMeta(meta, "Geom types", rg.geometryTypes?.length ? rg.geometryTypes.join(", ") : "—");
  item.appendChild(meta);

  item.addEventListener("click", () => {
    onRowSelect(rg, { fit: false });
    closeCandidatePopup();
  });
  item.addEventListener("mouseenter", () => {
    if (rg.bbox) setHovered(map, rg.index);
  });
  item.addEventListener("mouseleave", () => {
    setHovered(map, null);
  });

  return item;
}

function appendMeta(dl: HTMLDListElement, key: string, value: string, mono = false) {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (mono) dd.classList.add("mono");
  dl.append(dt, dd);
}

let mapReady = false;
map.on("load", () => {
  mapReady = true;
  renderMap();
});

onRowGroupClick(map, (indices, lngLat) => {
  if (drawSession || suppressMapClick) return;
  showCandidatePopup(lngLat, indices);
});

onRowGroupHover(map, (index) => {
  setHovered(map, index);
  for (const tr of rgTbody.querySelectorAll<HTMLTableRowElement>("tr")) {
    tr.classList.toggle("hovered", index !== null && tr.dataset.index === String(index));
  }
});

function renderMap() {
  if (!current) return;
  if (!mapReady) return; // Will be flushed once the map's initial load fires.
  const fc = buildFeatureCollection(visibleRowGroups(current), visibility);
  if (map.getSource("rowgroups")) updateFeatures(map, fc);
  else ensureLayers(map, fc);
}

function syncToggleAll() {
  if (!current) return;
  const all = current.rowGroups.length;
  const on = current.rowGroups.filter((r) => visibility.get(r.index) ?? true).length;
  toggleAllEl.checked = on === all;
  toggleAllEl.indeterminate = on > 0 && on < all;
}

function setAllVisibility(value: boolean) {
  if (!current) return;
  for (const rg of current.rowGroups) visibility.set(rg.index, value);
  for (const cb of rgTbody.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    cb.checked = value;
  }
  syncToggleAll();
  renderMap();
}

function setFilter(rect: BBox | null) {
  filterRect = rect;
  setFilterRect(map, rect);
  closeCandidatePopup();
  renderFilters();
  drawFilterBtn.hidden = rect !== null;
  if (!current) {
    updateMatchInfo();
    return;
  }
  // Drop selection if it no longer matches the combined filter.
  if (selectedIndex !== null) {
    const rg = current.rowGroups.find((r) => r.index === selectedIndex);
    if (!rg || !visibleRowGroups(current).some((v) => v.index === rg.index)) {
      clearSelection();
    }
  }
  renderRowGroupTable(current);
  renderMap();
  updateMatchInfo();
}

function cancelDraw() {
  if (drawSession) {
    drawSession.cancel();
    drawSession = null;
  }
  suppressMapClick = false;
  drawFilterBtn.textContent = "+ Rect";
  drawFilterBtn.classList.remove("primary");
}

function startDraw() {
  if (!current) {
    setStatus("Load a file before drawing a filter.", "error");
    return;
  }
  if (drawSession) {
    cancelDraw();
    return;
  }
  drawFilterBtn.textContent = "Drawing… (Esc)";
  drawFilterBtn.classList.add("primary");
  suppressMapClick = true;
  drawSession = startDrawRectangle(map, (b) => {
    drawSession = null;
    drawFilterBtn.textContent = "+ Rect";
    drawFilterBtn.classList.remove("primary");
    setTimeout(() => {
      suppressMapClick = false;
    }, 0);
    if (b) setFilter(b);
  });
}

loadUrlBtn.addEventListener("click", () => {
  void handleUrl();
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void handleUrl();
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void handleFile(f);
  fileInput.value = "";
});

let dragDepth = 0;
function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});
toggleAllEl.addEventListener("change", () => {
  setAllVisibility(toggleAllEl.checked);
});
showAllBtn.addEventListener("click", () => {
  setAllVisibility(true);
});
hideAllBtn.addEventListener("click", () => {
  setAllVisibility(false);
});
clearSelBtn.addEventListener("click", () => {
  clearSelection();
});
drawFilterBtn.addEventListener("click", () => {
  startDraw();
});
addColFilterBtn.addEventListener("click", () => {
  addColumnFilter();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (drawSession) {
    cancelDraw();
  } else if (selectedIndex !== null) {
    clearSelection();
  } else if (filterRect) {
    setFilter(null);
  }
});
