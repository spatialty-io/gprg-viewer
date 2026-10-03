import "./style.css";
import {
  buildFeatureCollection,
  colorFor,
  createMap,
  ensureLayers,
  fitToBBox,
  onRowGroupClick,
  onRowGroupHover,
  setHovered,
  setPageBboxes,
  setSelected,
  updateFeatures,
} from "./map.ts";
import type { RowGroupFeature, RowGroupState } from "./map.ts";
import { formatBBox, formatBytes, loadFromFile, loadFromUrl } from "./parquet.ts";
import type { BBox, ColumnStats, GeoParquetInfo, KeyValueEntry, RowGroupInfo } from "./parquet.ts";
import {
  analyzeCogp,
  levelColor,
  queryViewport,
  selectLevel,
  targetResolution,
} from "./cogp.ts";
import type { ByteBreakdown, CogpAnalysis, Issue, LevelAnalysis, ViewportQuery } from "./cogp.ts";
import maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";

const SAMPLES = [
  "https://cogp-demo.spatialty.io/v2.0.0/pois.cogp.parquet",
  "https://cogp-demo.spatialty.io/v2.0.0/segments.cogp.parquet",
  "https://cogp-demo.spatialty.io/v2.0.0/buildings.cogp.parquet",
  "https://cogp-demo.spatialty.io/v2.0.0/admin.cogp.parquet",
];

type ViewMode = "all" | "prefix" | "level" | "auto";
type Tab = "levels" | "rowgroups";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

app.innerHTML = `
  <header class="toolbar">
    <h1>COGP Layout Inspector</h1>
    <input
      id="url"
      type="text"
      list="samples"
      placeholder="https://example.com/data.cogp.parquet"
      autocomplete="off"
      spellcheck="false"
    />
    <datalist id="samples">
      ${SAMPLES.map((url) => `<option value="${url}"></option>`).join("")}
    </datalist>
    <button id="load-url" class="primary" type="button">Load URL</button>
    <label class="file">
      Open file
      <input id="file" type="file" accept=".parquet,.geoparquet,application/octet-stream" hidden />
    </label>
    <span id="status" class="status">Open a COGP (GeoParquet) file to begin.</span>
    <a
      class="repo-link"
      href="https://github.com/spatialty-io/gprg-viewer"
      target="_blank"
      rel="noopener noreferrer"
      title="View source on GitHub"
      aria-label="View source on GitHub"
    >
      <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
    </a>
  </header>
  <main>
    <div id="map"></div>
    <div class="level-panel" id="level-panel" hidden>
      <div class="lp-row">
        <label for="view-mode">View</label>
        <select id="view-mode">
          <option value="auto">Auto: level for map zoom</option>
          <option value="prefix">Prefix up to level</option>
          <option value="level">Rows added by level</option>
          <option value="all">All row groups</option>
        </select>
      </div>
      <div class="lp-row" id="level-row">
        <input id="level-slider" type="range" min="0" max="0" step="1" value="0" />
        <span id="level-label" class="lp-level"></span>
      </div>
      <div id="viewport-info" class="viewport-info"></div>
    </div>
  </main>
  <section class="bottom">
    <div class="file-stats" id="file-stats" hidden></div>
    <details class="meta-block issues" id="issues" hidden>
      <summary><span class="meta-label">COGP validation</span> <span class="meta-count" id="issues-count"></span></summary>
      <ul class="issue-list" id="issue-list"></ul>
    </details>
    <details class="meta-block kv-meta" id="kv-meta" hidden>
      <summary><span class="meta-label">Parquet key/value metadata</span> <span class="meta-count" id="kv-meta-count"></span></summary>
      <div class="kv-meta-list" id="kv-meta-list"></div>
    </details>
    <div class="layout-strip" id="layout-strip" hidden>
      <div class="strip-label">File layout <span class="muted">(byte offsets, colored by level)</span></div>
      <div class="strip-track" id="strip-levels"></div>
      <div class="strip-track bytes" id="strip-bytes"></div>
    </div>
    <div class="controls">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab active" data-tab="levels">Levels</button>
        <button type="button" role="tab" class="tab" data-tab="rowgroups">Row groups</button>
      </div>
      <span class="legend" id="legend"></span>
      <button id="clear-sel" type="button" hidden class="clear-sel">Clear selection</button>
    </div>
    <div class="panes" id="panes">
      <div class="pane">
        <div class="table-wrap">
          <div id="empty-main" class="empty">Open a COGP (GeoParquet) file to begin.</div>
          <table class="rg" id="level-table" hidden>
            <thead>
              <tr>
                <th>Level</th>
                <th title="Nominal rendering resolution in CRS units">Resolution</th>
                <th title="Map zoom range (512px tiles, equator) for which this level is selected">Zoom</th>
                <th title="Row groups introduced by this level">New RGs</th>
                <th>New rows</th>
                <th>Prefix rows</th>
                <th>New bytes</th>
                <th>Prefix bytes</th>
                <th title="Overview LoD used to render this level">LoD</th>
                <th title="Geometry bytes to render the whole prefix: overview LoD vs primary geometry">Prefix geometry</th>
                <th title="Sum of new row group bbox areas / area of their union. 1.0 = no overlap">BBox overlap</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
          <table class="rg" id="rg-table" hidden>
            <thead>
              <tr>
                <th>#</th>
                <th>Level</th>
                <th>Rows</th>
                <th>Compressed</th>
                <th title="Primary geometry / overview / bbox covering / attributes">Bytes by role</th>
                <th>Primary geom</th>
                <th>Overviews</th>
                <th>Byte range</th>
                <th>BBox (xmin, ymin, xmax, ymax)</th>
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
                <th>Role</th>
                <th>Type</th>
                <th>Codec</th>
                <th>Encodings</th>
                <th>Values</th>
                <th>Nulls</th>
                <th>Compressed</th>
                <th>Uncompressed</th>
                <th title="Column Index + Offset Index present">Page index</th>
                <th>Min</th>
                <th>Max</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
  <div class="drop-overlay" id="drop-overlay" hidden>
    <div class="drop-overlay-inner">Drop a COGP (GeoParquet) file to open</div>
  </div>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const map: MLMap = createMap($<HTMLDivElement>("#map"));

const urlInput = $<HTMLInputElement>("#url");
const loadUrlBtn = $<HTMLButtonElement>("#load-url");
const fileInput = $<HTMLInputElement>("#file");
const statusEl = $<HTMLSpanElement>("#status");
const levelPanel = $<HTMLDivElement>("#level-panel");
const viewModeEl = $<HTMLSelectElement>("#view-mode");
const levelRow = $<HTMLDivElement>("#level-row");
const levelSlider = $<HTMLInputElement>("#level-slider");
const levelLabel = $<HTMLSpanElement>("#level-label");
const viewportInfo = $<HTMLDivElement>("#viewport-info");
const fileStatsEl = $<HTMLDivElement>("#file-stats");
const issuesEl = $<HTMLDetailsElement>("#issues");
const issuesCountEl = $<HTMLSpanElement>("#issues-count");
const issueListEl = $<HTMLUListElement>("#issue-list");
const kvMetaEl = $<HTMLDetailsElement>("#kv-meta");
const kvMetaListEl = $<HTMLDivElement>("#kv-meta-list");
const kvMetaCountEl = $<HTMLSpanElement>("#kv-meta-count");
const stripEl = $<HTMLDivElement>("#layout-strip");
const stripLevelsEl = $<HTMLDivElement>("#strip-levels");
const stripBytesEl = $<HTMLDivElement>("#strip-bytes");
const legendEl = $<HTMLSpanElement>("#legend");
const clearSelBtn = $<HTMLButtonElement>("#clear-sel");
const emptyMain = $<HTMLDivElement>("#empty-main");
const levelTable = $<HTMLTableElement>("#level-table");
const levelTbody = levelTable.querySelector("tbody")!;
const rgTable = $<HTMLTableElement>("#rg-table");
const rgTbody = rgTable.querySelector("tbody")!;
const colPane = $<HTMLDivElement>("#col-pane");
const colHeader = $<HTMLDivElement>("#col-pane-header");
const colTable = $<HTMLTableElement>("#col-table");
const colTbody = colTable.querySelector("tbody")!;
const colEmpty = $<HTMLDivElement>("#empty-col");
const dropOverlay = $<HTMLDivElement>("#drop-overlay");
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>(".tab")];

interface Loaded {
  info: GeoParquetInfo;
  cogp: CogpAnalysis;
  /** Longitude/latitude bbox per row group, or null when it cannot be drawn. */
  lngLat: (BBox | null)[];
}

let current: Loaded | null = null;
let selectedIndex: number | null = null;
let viewMode: ViewMode = "auto";
let selectedLevel = 0;
let tab: Tab = "levels";
let lastQuery: ViewportQuery | null = null;
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
    writeUrlParam(url);
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
    writeUrlParam(null);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to read ${file.name}: ${formatError(err)}`, "error");
  } finally {
    setBusy(false);
  }
}

function writeUrlParam(url: string | null) {
  const next = new URL(window.location.href);
  if (url) next.searchParams.set("url", url);
  else next.searchParams.delete("url");
  window.history.replaceState(null, "", next);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function onLoaded(info: GeoParquetInfo, label: string) {
  closeCandidatePopup();
  const cogp = analyzeCogp(info);
  const lngLat = info.rowGroups.map((rg) => toDisplayBBox(rg.bbox, cogp));
  current = { info, cogp, lngLat };
  selectedIndex = null;
  lastQuery = null;
  const levelCount = cogp.levelAnalyses.length;
  selectedLevel = 0;
  viewMode = levelCount === 0 ? "all" : cogp.units.metresPerUnit !== null && cogp.fromLngLat ? "auto" : "prefix";
  viewModeEl.value = viewMode;
  for (const option of viewModeEl.options) {
    if (option.value === "auto") option.disabled = !(cogp.units.metresPerUnit !== null && cogp.fromLngLat);
    else if (option.value !== "all") option.disabled = levelCount === 0;
  }
  levelSlider.max = String(Math.max(0, levelCount - 1));
  levelSlider.value = "0";
  levelPanel.hidden = false;
  clearSelBtn.hidden = true;
  setTab(levelCount > 0 ? "levels" : "rowgroups");

  renderFileStats(info, cogp, label);
  renderIssues(cogp.issues);
  renderKeyValueMetadata(info.keyValueMetadata);
  renderLegend();
  renderStrip();
  renderLevelTable();
  renderRowGroupTable();
  renderColumnTable(null);
  setSelected(map, null);
  setPageBboxes(map, []);
  fitToAll();
  refreshView();

  const drawable = lngLat.filter((b) => b !== null).length;
  const notes: string[] = [];
  if (!cogp.declared) notes.push("no geo.lod");
  else if (!cogp.valid) notes.push("invalid geo.lod");
  if (drawable < info.rowGroups.length) notes.push(`${info.rowGroups.length - drawable} RG(s) not drawable`);
  setStatus(`Loaded ${label}${notes.length ? ` · ${notes.join(" · ")}` : ""}.`, cogp.valid ? "info" : "error");
}

function toDisplayBBox(bbox: BBox | null, cogp: CogpAnalysis): BBox | null {
  if (!bbox) return null;
  if (cogp.toLngLat) return cogp.toLngLat(bbox);
  // Unknown CRS: draw only coordinates that look like longitude/latitude.
  const inRange =
    bbox.xmin >= -180 && bbox.xmax <= 180 && bbox.ymin >= -90 && bbox.ymax <= 90;
  return inRange ? bbox : null;
}

// ---------------------------------------------------------------------------
// Summary panels

function renderFileStats(info: GeoParquetInfo, cogp: CogpAnalysis, label: string) {
  const totalRows = info.rowGroups.reduce((s, r) => s + r.numRows, 0);
  const compressed = info.rowGroups.reduce((s, r) => s + r.totalCompressedBytes, 0);
  const stats: Array<[string, string, string?]> = [
    ["Source", label, label],
    ["File size", info.fileSize !== null ? formatBytes(info.fileSize) : "—"],
    ["Footer", info.metadataLength !== null ? formatBytes(info.metadataLength) : "—"],
    ["Writer", info.createdBy ?? "—", info.createdBy ?? undefined],
    ["Row groups", info.rowGroups.length.toLocaleString()],
    ["Rows", totalRows.toLocaleString()],
    ["Compressed", formatBytes(compressed)],
  ];
  if (info.geoVersion) stats.push(["GeoParquet", info.geoVersion]);
  if (info.primaryColumn) stats.push(["Geometry", info.primaryColumn]);
  if (info.crs) stats.push(["CRS", `${info.crs} (${cogp.units.label})`]);
  stats.push(["COGP", !cogp.declared ? "not declared" : cogp.valid ? "valid" : "invalid"]);
  if (cogp.declared) stats.push(["Levels", cogp.levels.length.toLocaleString()]);
  if (cogp.overviews) {
    const overviewBytes = cogp.breakdown.reduce((sum, b) => sum + b.overview, 0);
    const primaryBytes = cogp.breakdown.reduce((sum, b) => sum + b.primary, 0);
    stats.push([
      "Overviews",
      `${cogp.overviews.column} · ${cogp.overviews.encoding} · ${cogp.overviews.lods.length} LoD(s)`,
    ]);
    stats.push([
      "Bytes by role",
      `overviews ${formatShare(overviewBytes, compressed)} · primary ${formatShare(primaryBytes, compressed)}`,
    ]);
  } else if (cogp.declared) {
    stats.push(["Overviews", "none"]);
  }

  fileStatsEl.innerHTML = "";
  for (const [k, v, title] of stats) {
    const item = el("div", "stat");
    const key = el("span", "stat-key", k);
    const val = el("span", "stat-val", v);
    if (k === "COGP") val.classList.add(cogp.valid ? "ok" : "bad");
    val.title = title ?? v;
    item.append(key, val);
    fileStatsEl.appendChild(item);
  }
  fileStatsEl.hidden = false;
}

function renderIssues(issues: Issue[]) {
  issueListEl.innerHTML = "";
  issuesEl.hidden = false;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  issuesCountEl.textContent =
    issues.length === 0
      ? "no issues"
      : (["error", "warning", "info"] as const)
          .filter((s) => counts[s] > 0)
          .map((s) => `${counts[s]} ${s}${counts[s] === 1 ? "" : "s"}`)
          .join(" · ");
  issuesCountEl.className = `meta-count ${counts.error ? "bad" : counts.warning ? "warn" : "ok"}`;
  issuesEl.open = counts.error > 0;
  if (issues.length === 0) {
    issueListEl.appendChild(el("li", "issue info", "geo.lod is consistent with the footer."));
  }
  for (const issue of issues) {
    const li = el("li", `issue ${issue.severity}`);
    li.append(el("span", "issue-sev", issue.severity), el("span", "issue-msg", issue.message));
    issueListEl.appendChild(li);
  }
}

function renderKeyValueMetadata(entries: KeyValueEntry[]) {
  kvMetaListEl.innerHTML = "";
  if (entries.length === 0) {
    kvMetaEl.hidden = true;
    kvMetaEl.open = false;
    return;
  }
  kvMetaEl.hidden = false;
  kvMetaCountEl.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  for (const entry of entries) {
    const item = el("div", "kv-meta-item");
    item.appendChild(el("div", "kv-meta-key", entry.key));
    item.appendChild(el("pre", "kv-meta-value mono", formatKeyValue(entry.value)));
    kvMetaListEl.appendChild(item);
  }
}

function formatKeyValue(value: string | null): string {
  if (value === null) return "(null)";
  if (value === "") return "(empty)";
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // fall through
    }
  }
  return value;
}

function renderLegend() {
  legendEl.innerHTML = "";
  for (const [role, label] of ROLE_LABELS) {
    const item = el("span", "legend-item");
    const sw = el("span", `role-swatch role-${role}`);
    item.append(sw, label);
    legendEl.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Layout strip

function rowGroupColor(index: number): string {
  if (!current) return colorFor(index);
  const level = current.cogp.rowGroupLevel[index];
  const count = current.cogp.levels.length;
  return level === null ? colorFor(index) : levelColor(level, count);
}

function renderStrip() {
  stripLevelsEl.innerHTML = "";
  stripBytesEl.innerHTML = "";
  if (!current) return;
  const { info, cogp } = current;
  const end =
    info.fileSize ??
    Math.max(0, ...info.rowGroups.map((rg) => rg.byteEnd ?? 0)) + (info.metadataLength ?? 0) + 8;
  if (end <= 0 || info.rowGroups.length === 0) {
    stripEl.hidden = true;
    return;
  }
  stripEl.hidden = false;
  const pct = (bytes: number) => `${((bytes / end) * 100).toFixed(4)}%`;

  // Row groups by byte range.
  for (const rg of info.rowGroups) {
    if (rg.byteStart === null || rg.byteEnd === null) continue;
    const seg = el("div", "seg rg-seg");
    seg.dataset.index = String(rg.index);
    seg.style.left = pct(rg.byteStart);
    seg.style.width = pct(rg.byteEnd - rg.byteStart);
    seg.style.background = rowGroupColor(rg.index);
    const level = cogp.rowGroupLevel[rg.index];
    seg.title = `RG #${rg.index}${level !== null ? ` · level ${level}` : ""} · ${rg.numRows.toLocaleString()} rows · ${formatBytes(rg.totalCompressedBytes)} @ ${rg.byteStart.toLocaleString()}`;
    bindRowGroupHover(seg, rg.index);
    seg.addEventListener("click", () => selectRowGroup(rg.index, { fit: true }));
    stripBytesEl.appendChild(seg);
  }
  if (info.pageIndexRange) {
    const { start, end: stop } = info.pageIndexRange;
    const pageIndex = el("div", "seg page-index-seg");
    pageIndex.style.left = pct(start);
    pageIndex.style.width = pct(stop - start);
    pageIndex.title = `Page Index (Column + Offset Index) · ${formatBytes(stop - start)} @ ${start.toLocaleString()}`;
    stripBytesEl.appendChild(pageIndex);
  }
  if (info.metadataLength !== null && info.fileSize !== null) {
    const footer = el("div", "seg footer-seg");
    footer.style.left = pct(info.fileSize - info.metadataLength - 8);
    footer.style.width = pct(info.metadataLength + 8);
    footer.title = `Footer · ${formatBytes(info.metadataLength)}`;
    stripBytesEl.appendChild(footer);
  }

  // Level spans over the same byte axis.
  for (const level of cogp.levelAnalyses) {
    if (level.newRowGroups === 0) continue;
    const first = info.rowGroups[level.firstNewRowGroup];
    const last = info.rowGroups[Math.min(level.rowGroupEnd, info.rowGroups.length - 1)];
    if (!first || !last || first.byteStart === null || last.byteEnd === null) continue;
    const start = Math.min(first.byteStart, last.byteStart ?? first.byteStart);
    const stop = Math.max(last.byteEnd, first.byteEnd ?? last.byteEnd);
    const span = el("div", "seg level-seg");
    span.dataset.level = String(level.index);
    span.style.left = pct(start);
    span.style.width = pct(stop - start);
    span.style.background = levelColor(level.index, cogp.levels.length);
    span.title = `Level ${level.index} · RG ${level.firstNewRowGroup}–${level.rowGroupEnd} · ${formatBytes(level.newBytes)}`;
    if ((stop - start) / end > 0.025) span.textContent = `L${level.index}`;
    span.addEventListener("click", () => focusLevel(level.index));
    stripLevelsEl.appendChild(span);
  }
}

// ---------------------------------------------------------------------------
// Tables

const ROLE_LABELS: Array<[keyof Omit<ByteBreakdown, "overviewByLod" | "total">, string]> = [
  ["primary", "primary geom"],
  ["overview", "overviews"],
  ["covering", "bbox covering"],
  ["attribute", "attributes"],
];

function setTab(next: Tab) {
  tab = next;
  for (const button of tabButtons) {
    const active = button.dataset.tab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  updateTableVisibility();
}

function updateTableVisibility() {
  if (!current) {
    levelTable.hidden = true;
    rgTable.hidden = true;
    emptyMain.hidden = false;
    return;
  }
  const noLevels = current.cogp.levelAnalyses.length === 0;
  levelTable.hidden = tab !== "levels" || noLevels;
  rgTable.hidden = tab !== "rowgroups" || current.info.rowGroups.length === 0;
  emptyMain.hidden = !(levelTable.hidden && rgTable.hidden);
  emptyMain.textContent =
    tab === "levels" ? "No geo.lod levels in this file." : "No row groups found.";
}

function renderLevelTable() {
  levelTbody.innerHTML = "";
  if (!current) return;
  const { cogp } = current;
  const total = cogp.levelAnalyses.at(-1)?.cumulativeBytes ?? 0;
  for (const level of cogp.levelAnalyses) {
    const tr = document.createElement("tr");
    tr.dataset.level = String(level.index);
    const tdLevel = el("td");
    tdLevel.append(swatch(levelColor(level.index, cogp.levels.length)), `L${level.index}`);
    tr.append(
      tdLevel,
      td(formatNumber(level.resolution), "num mono"),
      td(formatZoomRange(level), "mono"),
      td(
        level.newRowGroups === 0
          ? "— (refines)"
          : `${level.newRowGroups.toLocaleString()} (${level.firstNewRowGroup}–${level.rowGroupEnd})`,
        "num",
      ),
      td(level.newRows.toLocaleString(), "num"),
      td(level.cumulativeRows.toLocaleString(), "num muted"),
      td(formatBytes(level.newBytes), "num"),
      tdBar(level.cumulativeBytes, total),
      tdLod(level.lod),
      td(formatPrefixGeometry(level), "num"),
      td(level.overlap === null ? "—" : `${level.overlap.toFixed(2)}×`, `num ${overlapClass(level.overlap)}`),
    );
    tr.addEventListener("click", () => focusLevel(level.index));
    levelTbody.appendChild(tr);
  }
  syncLevelRows();
}

function formatZoomRange(level: LevelAnalysis): string {
  const z = (v: number | null) => (v === null ? null : v.toFixed(1));
  const from = z(level.zoomFrom);
  const to = z(level.zoomTo);
  if (from === null && to === null) {
    return current?.cogp.units.metresPerUnit === null ? "—" : "all";
  }
  if (from === null) return `< ${to}`;
  if (to === null) return `≥ ${from}`;
  return `${from} – ${to}`;
}

function formatPrefixGeometry(level: LevelAnalysis): string {
  if (!level.lod) return formatBytes(level.prefix.primary);
  const ratio = level.prefix.primary > 0 ? level.prefix.overview / level.prefix.primary : 0;
  return `${formatBytes(level.prefix.overview)} vs ${formatBytes(level.prefix.primary)} (${(ratio * 100).toFixed(0)}%)`;
}

function overlapClass(overlap: number | null): string {
  if (overlap === null) return "muted";
  if (overlap < 1.5) return "ok";
  if (overlap < 3) return "warn";
  return "bad";
}

function tdLod(lod: string | null): HTMLTableCellElement {
  const cell = td(lod ?? "—", "mono");
  const def = current?.cogp.overviews?.lods.find((l) => l.name === lod);
  if (def) {
    cell.title = [
      def.geometryType ? `geometry_type: ${def.geometryType}` : null,
      def.scale ? `scale: [${def.scale.join(", ")}]` : null,
      def.offset ? `offset: [${def.offset.join(", ")}]` : null,
      `level_indices: [${def.levelIndices.join(", ")}]`,
      `effective boundary: RG ${def.effectiveEnd}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return cell;
}

function tdBar(value: number, total: number): HTMLTableCellElement {
  const cell = td("", "num bar-cell");
  const bar = el("span", "bar");
  bar.style.width = `${total > 0 ? (value / total) * 100 : 0}%`;
  cell.append(bar, el("span", "bar-label", formatBytes(value)));
  return cell;
}

function renderRowGroupTable() {
  rgTbody.innerHTML = "";
  if (!current) return;
  const { info, cogp } = current;
  for (const rg of info.rowGroups) {
    const b = cogp.breakdown[rg.index];
    const level = cogp.rowGroupLevel[rg.index];
    const tr = document.createElement("tr");
    tr.dataset.index = String(rg.index);

    const tdIndex = el("td");
    tdIndex.append(swatch(rowGroupColor(rg.index)), String(rg.index));

    const roleBar = el("td", "role-cell");
    const stack = el("div", "role-bar");
    stack.title = ROLE_LABELS.map(([role, label]) => `${label}: ${formatBytes(b[role])}`).join("\n");
    for (const [role] of ROLE_LABELS) {
      if (b[role] <= 0 || b.total <= 0) continue;
      const part = el("span", `role-${role}`);
      part.style.width = `${(b[role] / b.total) * 100}%`;
      stack.appendChild(part);
    }
    roleBar.appendChild(stack);

    // LoDs whose coverage includes this row group; later LoDs are null here.
    const covering = (cogp.overviews?.lods ?? []).filter((lod) => lod.effectiveEnd >= rg.index);
    const tdOverviews = td(
      cogp.overviews ? `${formatBytes(b.overview)} · ${covering.length} LoD${covering.length === 1 ? "" : "s"}` : "—",
      "num",
    );
    tdOverviews.title = Object.entries(b.overviewByLod)
      .map(([lod, bytes]) => `${lod}: ${formatBytes(bytes)}`)
      .join("\n");

    tr.append(
      tdIndex,
      td(level === null ? "—" : `L${level}`, "mono"),
      td(rg.numRows.toLocaleString(), "num"),
      td(formatBytes(rg.totalCompressedBytes), "num"),
      roleBar,
      td(formatBytes(b.primary), "num"),
      tdOverviews,
      td(
        rg.byteStart !== null && rg.byteEnd !== null
          ? `${rg.byteStart.toLocaleString()} – ${rg.byteEnd.toLocaleString()}`
          : "—",
        "num mono",
      ),
      td(rg.bbox ? formatBBox(rg.bbox) : "—", "bbox"),
    );
    tr.addEventListener("click", () => selectRowGroup(rg.index, { fit: true }));
    bindRowGroupHover(tr, rg.index);
    rgTbody.appendChild(tr);
  }
  syncRowGroupRows();
}

function renderColumnTable(rg: RowGroupInfo | null) {
  colTbody.innerHTML = "";
  if (!rg || !current) {
    colPane.hidden = true;
    colTable.hidden = true;
    colEmpty.hidden = true;
    colHeader.textContent = "";
    return;
  }
  colPane.hidden = false;
  renderColumnHeader(rg);
  if (rg.columns.length === 0) {
    colTable.hidden = true;
    colEmpty.hidden = false;
    return;
  }
  colTable.hidden = false;
  colEmpty.hidden = true;
  for (const col of rg.columns) colTbody.appendChild(buildColumnRow(col));
}

function renderColumnHeader(rg: RowGroupInfo, pageIndexStatus?: string) {
  const level = current?.cogp.rowGroupLevel[rg.index];
  const suffix = pageIndexStatus ? ` · ${pageIndexStatus}` : "";
  colHeader.textContent = `Row group #${rg.index}${level !== null && level !== undefined ? ` · level ${level}` : ""} · ${rg.columns.length} column${rg.columns.length === 1 ? "" : "s"}${suffix}`;
}

function buildColumnRow(col: ColumnStats): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const role = current!.cogp.columnRole(col);
  const tdPath = td(col.path, "mono");
  tdPath.style.color = "var(--fg)";
  const tdRole = el("td");
  tdRole.append(el("span", `role-swatch role-${role}`), role);
  tr.append(
    tdPath,
    tdRole,
    td(col.type, "muted"),
    td(col.codec, "muted"),
    td(col.encodings.join(", "), "muted small"),
    td(col.numValues.toLocaleString(), "num"),
    td(col.nullCount !== null ? col.nullCount.toLocaleString() : "—", "num"),
    td(formatBytes(col.compressedBytes), "num"),
    td(formatBytes(col.uncompressedBytes), "num muted"),
    td(col.hasPageIndex ? "yes" : "—", col.hasPageIndex ? "ok" : "muted"),
    tdTitled(col.min ?? "—", "mono"),
    tdTitled(col.max ?? "—", "mono"),
  );
  return tr;
}

// ---------------------------------------------------------------------------
// Selection and hover

function selectRowGroup(index: number, options: { fit?: boolean } = {}) {
  if (!current) return;
  if (selectedIndex === index) {
    clearSelection();
    return;
  }
  const rg = current.info.rowGroups[index];
  const display = current.lngLat[index];
  selectedIndex = index;
  syncRowGroupRows();
  setSelected(map, display ? index : null);
  setPageBboxes(map, []);
  renderColumnTable(rg);
  renderColumnHeader(rg, "Loading Page Index…");
  if (display && options.fit) fitToBBox(map, display);
  clearSelBtn.hidden = false;
  void showPageBboxes(rg);
}

async function showPageBboxes(rg: RowGroupInfo) {
  if (!current) return;
  const loaded = current;
  try {
    const bboxes = await loaded.info.loadPageBboxes(rg.index);
    if (current !== loaded || selectedIndex !== rg.index) return;
    const display = bboxes
      .map((b) => toDisplayBBox(b, loaded.cogp))
      .filter((b): b is BBox => b !== null);
    setPageBboxes(map, display);
    renderColumnHeader(
      rg,
      bboxes.length === 0
        ? "Page Index bbox unavailable"
        : `${bboxes.length.toLocaleString()} Page Index bbox${bboxes.length === 1 ? "" : "es"}`,
    );
  } catch (err) {
    if (current !== loaded || selectedIndex !== rg.index) return;
    setPageBboxes(map, []);
    renderColumnHeader(rg, "Page Index read failed");
    setStatus(`Failed to read Page Index: ${formatError(err)}`, "error");
  }
}

function clearSelection() {
  selectedIndex = null;
  syncRowGroupRows();
  setSelected(map, null);
  setPageBboxes(map, []);
  renderColumnTable(null);
  clearSelBtn.hidden = true;
}

function syncRowGroupRows() {
  for (const tr of rgTbody.querySelectorAll<HTMLTableRowElement>("tr")) {
    tr.classList.toggle("selected", tr.dataset.index === String(selectedIndex));
  }
  for (const seg of stripBytesEl.querySelectorAll<HTMLElement>(".rg-seg")) {
    seg.classList.toggle("selected", seg.dataset.index === String(selectedIndex));
  }
}

function syncLevelRows() {
  const focused = viewMode === "all" ? null : effectiveLevel();
  for (const tr of levelTbody.querySelectorAll<HTMLTableRowElement>("tr")) {
    tr.classList.toggle("selected", tr.dataset.level === String(focused));
  }
  for (const seg of stripLevelsEl.querySelectorAll<HTMLElement>(".level-seg")) {
    seg.classList.toggle("selected", seg.dataset.level === String(focused));
  }
}

function bindRowGroupHover(target: HTMLElement, index: number) {
  target.addEventListener("mouseenter", () => highlightRowGroup(index));
  target.addEventListener("mouseleave", () => highlightRowGroup(null));
}

function highlightRowGroup(index: number | null) {
  setHovered(map, index !== null && current?.lngLat[index] ? index : null);
  for (const node of [
    ...rgTbody.querySelectorAll<HTMLElement>("tr"),
    ...stripBytesEl.querySelectorAll<HTMLElement>(".rg-seg"),
  ]) {
    node.classList.toggle("hovered", index !== null && node.dataset.index === String(index));
  }
}

function closeCandidatePopup() {
  setHovered(map, null);
  candidatePopup?.remove();
  candidatePopup = null;
}

function showCandidatePopup(lngLat: maplibregl.LngLat, indices: number[]) {
  if (!current) return;
  closeCandidatePopup();
  const candidates = indices
    .map((i) => current!.info.rowGroups[i])
    .filter((rg): rg is RowGroupInfo => rg !== undefined)
    .sort((a, b) => a.index - b.index);
  if (candidates.length === 0) return;

  const container = el("div", "candidate-popup");
  container.appendChild(
    el(
      "div",
      "candidate-title",
      candidates.length === 1 ? `Row group #${candidates[0].index}` : `${candidates.length} row groups`,
    ),
  );
  const list = el("div", "candidate-list");
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
  const { cogp } = current!;
  const item = el("button", "candidate-item");
  item.setAttribute("type", "button");
  if (selectedIndex === rg.index) item.classList.add("selected");
  const head = el("div", "candidate-head");
  head.append(swatch(rowGroupColor(rg.index)), el("span", "candidate-index", `#${rg.index}`));
  const level = cogp.rowGroupLevel[rg.index];
  if (level !== null) head.append(el("span", "candidate-level", `L${level}`));
  head.append(el("span", "candidate-rows muted", `${rg.numRows.toLocaleString()} rows`));
  item.appendChild(head);

  const b = cogp.breakdown[rg.index];
  const meta = el("dl", "candidate-meta") as HTMLDListElement;
  appendMeta(meta, "Compressed", formatBytes(rg.totalCompressedBytes));
  appendMeta(meta, "Primary geom", formatBytes(b.primary));
  if (cogp.overviews) appendMeta(meta, "Overviews", formatBytes(b.overview));
  appendMeta(meta, "Attributes", formatBytes(b.attribute));
  appendMeta(meta, "BBox", rg.bbox ? formatBBox(rg.bbox) : "—", true);
  item.appendChild(meta);

  item.addEventListener("click", () => {
    selectRowGroup(rg.index);
    closeCandidatePopup();
  });
  bindRowGroupHover(item, rg.index);
  return item;
}

function appendMeta(dl: HTMLDListElement, key: string, value: string, mono = false) {
  const dd = el("dd", mono ? "mono" : "", value);
  dl.append(el("dt", "", key), dd);
}

// ---------------------------------------------------------------------------
// Level view and viewport read estimate

function autoLevel(): { level: number; tileZoom: number; target: number } | null {
  if (!current || current.cogp.levels.length === 0) return null;
  const tileZoom = Math.max(0, Math.floor(map.getZoom()));
  const target = targetResolution(tileZoom, map.getCenter().lat, current.cogp.units);
  if (target === null) return null;
  return { level: selectLevel(current.cogp.levels, target), tileZoom, target };
}

function effectiveLevel(): number | null {
  if (!current || current.cogp.levels.length === 0) return null;
  if (viewMode === "auto") return autoLevel()?.level ?? null;
  if (viewMode === "all") return current.cogp.levels.length - 1;
  return selectedLevel;
}

function focusLevel(index: number) {
  if (!current) return;
  selectedLevel = index;
  levelSlider.value = String(index);
  if (viewMode === "auto" || viewMode === "all") {
    viewMode = "level";
    viewModeEl.value = viewMode;
  }
  const level = current.cogp.levelAnalyses[index];
  const bbox = level?.newBBox ? toDisplayBBox(level.newBBox, current.cogp) : null;
  if (bbox) fitToBBox(map, bbox, 60);
  refreshView();
}

function rowGroupState(index: number, level: number | null, hits: Set<number>): RowGroupState {
  if (!current || level === null) return "active";
  const def = current.cogp.levelAnalyses[level];
  const rgLevel = current.cogp.rowGroupLevel[index];
  switch (viewMode) {
    case "all":
      return "active";
    case "prefix":
      return index <= def.rowGroupEnd ? "active" : "hidden";
    case "level":
      if (rgLevel === level) return "active";
      return index <= def.rowGroupEnd ? "dim" : "hidden";
    case "auto":
      if (index > def.rowGroupEnd) return "hidden";
      return hits.has(index) ? "hit" : "dim";
  }
}

function refreshView() {
  if (!current) return;
  const level = effectiveLevel();
  levelRow.hidden = viewMode === "auto" || viewMode === "all" || current.cogp.levels.length === 0;
  levelLabel.textContent = levelRow.hidden ? "" : describeLevel(selectedLevel);

  lastQuery = level === null ? null : runViewportQuery(level);
  renderViewportInfo(level);
  syncLevelRows();

  if (!mapReady) return;
  const hits = new Set(lastQuery?.hits ?? []);
  const items: RowGroupFeature[] = [];
  for (const rg of current.info.rowGroups) {
    const bbox = current.lngLat[rg.index];
    if (!bbox) continue;
    items.push({
      index: rg.index,
      bbox,
      color: rowGroupColor(rg.index),
      state: rowGroupState(rg.index, level, hits),
    });
  }
  const fc = buildFeatureCollection(items);
  if (map.getSource("rowgroups")) updateFeatures(map, fc);
  else ensureLayers(map, fc);
}

function describeLevel(index: number): string {
  const level = current?.cogp.levelAnalyses[index];
  if (!level) return "";
  return `L${index} · res ${formatNumber(level.resolution)}${level.lod ? ` · ${level.lod}` : ""}`;
}

function viewportBBox(): BBox | null {
  if (!current?.cogp.fromLngLat) return null;
  const bounds = map.getBounds();
  const lngLat: BBox = {
    xmin: Math.max(-180, bounds.getWest()),
    ymin: Math.max(-90, bounds.getSouth()),
    xmax: Math.min(180, bounds.getEast()),
    ymax: Math.min(90, bounds.getNorth()),
  };
  return current.cogp.fromLngLat(lngLat);
}

function runViewportQuery(level: number): ViewportQuery | null {
  if (!current) return null;
  const viewport = viewportBBox();
  if (!viewport) return null;
  return queryViewport(current.info, current.cogp, level, viewport);
}

function renderViewportInfo(level: number | null) {
  viewportInfo.innerHTML = "";
  if (!current) return;
  const { cogp, info } = current;
  const lines: Array<[string, string, string?]> = [];
  const auto = autoLevel();
  lines.push([
    "Map zoom",
    `${map.getZoom().toFixed(2)}${auto ? ` · tile z${auto.tileZoom} · target ${formatNumber(auto.target)} ${unitSymbol()}/px` : ""}`,
  ]);
  if (level === null) {
    lines.push(["Level", cogp.declared ? "unavailable" : "no geo.lod"]);
  } else {
    const def = cogp.levelAnalyses[level];
    lines.push([
      viewMode === "auto" ? "Auto level" : "Level",
      `L${level} · res ${formatNumber(def.resolution)}${def.lod ? ` · LoD ${def.lod}` : ""}`,
    ]);
    lines.push([
      "Prefix",
      `RG 0–${def.rowGroupEnd} (${(def.rowGroupEnd + 1).toLocaleString()} of ${info.rowGroups.length.toLocaleString()}) · ${def.cumulativeRows.toLocaleString()} rows`,
    ]);
  }
  const q = lastQuery;
  if (q) {
    lines.push([
      "In view",
      `${q.hits.length.toLocaleString()} RG · ≤ ${q.rows.toLocaleString()} rows`,
      "Row groups in the prefix whose bbox intersects the viewport (row group pruning only; Page Index pruning can read less).",
    ]);
    lines.push([
      "Geometry",
      q.lod
        ? `${formatBytes(q.bytes.overview)} (${q.lod}) vs ${formatBytes(q.bytes.primary)} primary`
        : `${formatBytes(q.bytes.primary)} primary`,
    ]);
    lines.push(["Attributes", formatBytes(q.bytes.attribute)]);
    lines.push(["All columns", formatBytes(q.bytes.total)]);
  } else if (level !== null) {
    lines.push(["In view", "unavailable for this CRS"]);
  }
  const dl = el("dl", "vp-list") as HTMLDListElement;
  for (const [k, v, title] of lines) {
    const dt = el("dt", "", k);
    const dd = el("dd", "", v);
    if (title) dd.title = title;
    dl.append(dt, dd);
  }
  viewportInfo.appendChild(dl);
}

function unitSymbol(): string {
  const kind = current?.cogp.units.kind;
  return kind === "degree" ? "°" : kind === "metre" ? "m" : "units";
}

function fitToAll() {
  if (!current) return;
  const boxes = current.lngLat.filter((b): b is BBox => b !== null);
  if (boxes.length === 0) return;
  const union = boxes.reduce((u, b) => ({
    xmin: Math.min(u.xmin, b.xmin),
    ymin: Math.min(u.ymin, b.ymin),
    xmax: Math.max(u.xmax, b.xmax),
    ymax: Math.max(u.ymax, b.ymax),
  }));
  fitToBBox(map, union, 60);
}

// ---------------------------------------------------------------------------
// DOM helpers

function el(tag: string, className = "", text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function td(text: string, className = ""): HTMLTableCellElement {
  return el("td", className, text) as HTMLTableCellElement;
}

function tdTitled(text: string, className = ""): HTMLTableCellElement {
  const cell = td(text, className);
  cell.title = text;
  return cell;
}

function swatch(color: string): HTMLElement {
  const node = el("span", "swatch");
  node.style.background = color;
  return node;
}

function formatShare(part: number, total: number): string {
  return `${formatBytes(part)} (${total > 0 ? ((part / total) * 100).toFixed(0) : 0}%)`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7)) return n.toExponential(3);
  return n.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

// ---------------------------------------------------------------------------
// Events

let mapReady = false;
map.on("load", () => {
  mapReady = true;
  refreshView();
});
map.on("moveend", () => {
  if (current) refreshView();
});

onRowGroupClick(map, (indices, lngLat) => showCandidatePopup(lngLat, indices));
onRowGroupHover(map, (index) => highlightRowGroup(index));

viewModeEl.addEventListener("change", () => {
  viewMode = viewModeEl.value as ViewMode;
  refreshView();
});
levelSlider.addEventListener("input", () => {
  selectedLevel = Number(levelSlider.value);
  refreshView();
});
for (const button of tabButtons) {
  button.addEventListener("click", () => setTab(button.dataset.tab as Tab));
}
clearSelBtn.addEventListener("click", () => clearSelection());

loadUrlBtn.addEventListener("click", () => void handleUrl());
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
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (candidatePopup) closeCandidatePopup();
  else if (selectedIndex !== null) clearSelection();
});

const initialUrl = new URLSearchParams(window.location.search).get("url");
if (initialUrl) {
  urlInput.value = initialUrl;
  void handleUrl();
}
