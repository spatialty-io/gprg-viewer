import { parquetSchema } from "hyparquet";
import type { SchemaTree } from "hyparquet";
import type { BBox, ColumnStats, GeoParquetInfo, ProjJson } from "./parquet.ts";

// Analysis of the COGP / GeoParquet LoD extension (`geo.lod`) against a file's footer.
// See https://github.com/Kanahiro/cloud-optimized-geoparquet/blob/main/SPEC.md

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  message: string;
}

export interface LevelDef {
  rowGroupEnd: number;
  resolution: number;
}

export interface LodDef {
  name: string;
  levelIndices: number[];
  geometryType: string | null;
  scale: [number, number] | null;
  offset: [number, number] | null;
  /** Largest row_group_end among the levels that use this LoD. */
  effectiveEnd: number;
}

export interface OverviewsDef {
  column: string;
  encoding: string;
  supported: boolean;
  lods: LodDef[];
}

export interface ByteBreakdown {
  primary: number;
  overview: number;
  overviewByLod: Record<string, number>;
  covering: number;
  attribute: number;
  total: number;
}

export interface LevelAnalysis {
  index: number;
  resolution: number;
  rowGroupEnd: number;
  /** First row group introduced by this level; equals rowGroupEnd + 1 when none is added. */
  firstNewRowGroup: number;
  newRowGroups: number;
  newRows: number;
  cumulativeRows: number;
  newBytes: number;
  cumulativeBytes: number;
  lod: string | null;
  /** Map zoom range (512px tiles, at the equator) for which a renderer selects this level. */
  zoomFrom: number | null;
  zoomTo: number | null;
  /** Union of the bboxes of the row groups introduced by this level. */
  newBBox: BBox | null;
  /** Sum of new row group bbox areas divided by the area of their union; 1 means no overlap. */
  overlap: number | null;
  /** Bytes of the whole prefix, split by column role, rendering with this level's LoD. */
  prefix: ByteBreakdown;
}

export type UnitKind = "degree" | "metre" | "other" | "unknown";

export interface CrsUnits {
  kind: UnitKind;
  label: string;
  /** Equatorial metres per CRS unit, matching cogp-rs resolution auto-derivation. */
  metresPerUnit: number | null;
  webMercator: boolean;
}

export interface CogpAnalysis {
  /** geo.lod is present. */
  declared: boolean;
  /** geo.lod is present and valid, so readers may use it for prefix selection. */
  valid: boolean;
  issues: Issue[];
  levels: LevelDef[];
  levelAnalyses: LevelAnalysis[];
  overviews: OverviewsDef | null;
  /** Level that introduces each row group, or null when no level covers it. */
  rowGroupLevel: (number | null)[];
  breakdown: ByteBreakdown[];
  units: CrsUnits;
  /** Converts bboxes in the primary CRS to longitude/latitude, or null when unsupported. */
  toLngLat: ((b: BBox) => BBox) | null;
  fromLngLat: ((b: BBox) => BBox) | null;
  columnRole(column: ColumnStats): "primary" | "overview" | "covering" | "attribute";
}

const QUANTIZED_TYPES = ["LineString", "MultiLineString", "Polygon", "MultiPolygon"];
const WEB_MERCATOR_CIRCUMFERENCE_M = 40_075_016.685_578_49;
const EARTH_RADIUS_M = 6_378_137;
const METRES_PER_DEGREE = 111_320;
/** MapLibre vector tiles cover 512 CSS pixels. */
const TILE_SIZE = 512;

const GEOGRAPHIC_EPSG = new Set([4326, 4258, 4269, 4612, 4617, 4618, 4283, 6668, 7844, 4167]);
const WEB_MERCATOR_EPSG = new Set([3857, 900913, 3785, 102100]);

export function analyzeCogp(info: GeoParquetInfo): CogpAnalysis {
  const issues: Issue[] = [];
  const rowGroups = info.rowGroups;
  const n = rowGroups.length;
  const primary = info.primaryColumn;
  const geo = info.geo;
  const primaryDef = primary && geo?.columns ? geo.columns[primary] : undefined;
  const units = crsUnits(primaryDef ? primaryDef.crs : undefined, primaryDef !== undefined);

  const rawLod = geo?.lod;
  const declared = rawLod !== undefined;
  if (!geo) {
    issues.push({ severity: "error", message: 'No "geo" key/value metadata: not a GeoParquet file.' });
  } else if (!declared) {
    issues.push({
      severity: "error",
      message: "No geo.lod metadata: ordinary GeoParquet, not COGP. Row groups are shown without levels.",
    });
  }

  const levels = declared ? parseLevels(rawLod, n, issues) : [];
  const overviews = declared ? parseOverviews(rawLod, levels, info, issues) : null;

  // Without valid boundaries the level assignment below is best effort and for display only.
  const rowGroupLevel: (number | null)[] = new Array(n).fill(null);
  let previousEnd = -1;
  for (const [index, level] of levels.entries()) {
    const end = Math.min(level.rowGroupEnd, n - 1);
    for (let rg = Math.max(previousEnd + 1, 0); rg <= end; rg++) rowGroupLevel[rg] = index;
    previousEnd = Math.max(previousEnd, end);
  }

  const lodColumns = new Set(overviews?.lods.map((lod) => lod.name) ?? []);
  const coveringRoots = new Set(info.coveringRoots);
  const columnRole = (column: ColumnStats) => {
    const root = column.pathParts[0];
    if (root === primary) return "primary" as const;
    if (overviews && root === overviews.column) return "overview" as const;
    if (coveringRoots.has(root)) return "covering" as const;
    return "attribute" as const;
  };
  const breakdown = rowGroups.map((rg) => {
    const out: ByteBreakdown = {
      primary: 0,
      overview: 0,
      overviewByLod: {},
      covering: 0,
      attribute: 0,
      total: 0,
    };
    for (const column of rg.columns) {
      const bytes = column.compressedBytes;
      out.total += bytes;
      const role = columnRole(column);
      out[role] += bytes;
      if (role === "overview") {
        const lod = column.pathParts[1];
        if (lod !== undefined && lodColumns.has(lod)) {
          out.overviewByLod[lod] = (out.overviewByLod[lod] ?? 0) + bytes;
        }
      }
    }
    return out;
  });

  if (overviews) checkCoverage(info, overviews, issues);
  checkLayout(info, units, issues);

  const levelAnalyses = analyzeLevels(info, levels, overviews, breakdown, units);
  const valid = declared && !issues.some((issue) => issue.severity === "error");
  const projection = lngLatProjection(units);

  return {
    declared,
    valid,
    issues,
    levels,
    levelAnalyses,
    overviews,
    rowGroupLevel,
    breakdown,
    units,
    toLngLat: projection?.toLngLat ?? null,
    fromLngLat: projection?.fromLngLat ?? null,
    columnRole,
  };
}

function parseLevels(raw: unknown, n: number, issues: Issue[]): LevelDef[] {
  const error = (message: string) => issues.push({ severity: "error", message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("geo.lod must be an object.");
    return [];
  }
  if (n === 0) error("The file has no row groups; empty files must omit geo.lod.");
  const levels = (raw as { levels?: unknown }).levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    error("geo.lod.levels must be a non-empty array.");
    return [];
  }
  const out: LevelDef[] = [];
  let previousEnd = -Infinity;
  let previousResolution = Infinity;
  for (const [index, level] of levels.entries()) {
    const end = (level as { row_group_end?: unknown } | null)?.row_group_end;
    const resolution = (level as { resolution?: unknown } | null)?.resolution;
    if (typeof end !== "number" || !Number.isSafeInteger(end)) {
      error(`levels[${index}].row_group_end must be an integer.`);
      continue;
    }
    if (typeof resolution !== "number" || !Number.isFinite(resolution) || resolution <= 0) {
      error(`levels[${index}].resolution must be a positive finite number.`);
      continue;
    }
    if (end < 0 || end >= n) {
      error(`levels[${index}].row_group_end ${end} is outside the footer's ${n} row group(s).`);
    }
    if (end < previousEnd) {
      error(`levels[${index}].row_group_end ${end} decreases from ${previousEnd}.`);
    }
    if (resolution >= previousResolution) {
      error(`levels[${index}].resolution ${resolution} does not strictly decrease from ${previousResolution}.`);
    }
    previousEnd = Math.max(previousEnd, end);
    previousResolution = resolution;
    out.push({ rowGroupEnd: end, resolution });
  }
  const last = out.at(-1);
  if (last && n > 0 && last.rowGroupEnd !== n - 1) {
    error(`The final level ends at row group ${last.rowGroupEnd}; it must include the last row group (${n - 1}).`);
  }
  return out;
}

function parseOverviews(
  raw: unknown,
  levels: LevelDef[],
  info: GeoParquetInfo,
  issues: Issue[],
): OverviewsDef | null {
  const error = (message: string) => issues.push({ severity: "error", message });
  const overviews = (raw as { overviews?: unknown } | null)?.overviews;
  if (overviews === undefined) return null;
  if (!overviews || typeof overviews !== "object" || Array.isArray(overviews)) {
    error("geo.lod.overviews must be an object.");
    return null;
  }
  const { column, encoding, lods } = overviews as {
    column?: unknown;
    encoding?: unknown;
    lods?: unknown;
  };
  if (typeof column !== "string" || !column) error("overviews.column must be a non-empty string.");
  if (typeof encoding !== "string" || !encoding) error("overviews.encoding must be a non-empty string.");
  if (!lods || typeof lods !== "object" || Array.isArray(lods) || Object.keys(lods).length === 0) {
    error("overviews.lods must be a non-empty object.");
  }
  const supported = encoding === "quantized_geoarrow";
  if (typeof encoding === "string" && encoding && !supported) {
    issues.push({
      severity: "warning",
      message: `Overview encoding "${encoding}" is not supported here; its representation was not validated.`,
    });
  }

  const assigned = new Map<number, string[]>();
  const lodDefs: LodDef[] = [];
  for (const [name, value] of Object.entries((lods ?? {}) as Record<string, unknown>)) {
    const lod = (value ?? {}) as Record<string, unknown>;
    const indices = Array.isArray(lod.level_indices) ? lod.level_indices : null;
    if (!indices || indices.length === 0) {
      error(`overviews.lods.${name}.level_indices must be a non-empty array.`);
    }
    const levelIndices: number[] = [];
    for (const index of indices ?? []) {
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= levels.length) {
        error(`overviews.lods.${name}.level_indices contains ${JSON.stringify(index)}, outside 0..${levels.length - 1}.`);
        continue;
      }
      levelIndices.push(index);
      assigned.set(index, [...(assigned.get(index) ?? []), name]);
    }
    let geometryType: string | null = null;
    let scale: [number, number] | null = null;
    let offset: [number, number] | null = null;
    if (supported) {
      if (typeof lod.geometry_type === "string" && QUANTIZED_TYPES.includes(lod.geometry_type)) {
        geometryType = lod.geometry_type;
      } else {
        error(`overviews.lods.${name}.geometry_type must be one of ${QUANTIZED_TYPES.join(", ")}.`);
      }
      if (isPair(lod.scale, true)) scale = lod.scale;
      else error(`overviews.lods.${name}.scale must be two positive finite numbers.`);
      if (isPair(lod.offset, false)) offset = lod.offset;
      else error(`overviews.lods.${name}.offset must be two finite numbers.`);
    }
    const effectiveEnd = levelIndices.reduce(
      (max, index) => Math.max(max, levels[index]?.rowGroupEnd ?? -1),
      -1,
    );
    lodDefs.push({ name, levelIndices, geometryType, scale, offset, effectiveEnd });
  }
  for (const [index, names] of assigned) {
    if (names.length > 1) error(`Level ${index} is assigned to more than one LoD (${names.join(", ")}).`);
  }
  for (let index = 0; index < levels.length; index++) {
    if (!assigned.has(index)) error(`Level ${index} is not assigned to any overview LoD.`);
  }

  if (typeof column === "string" && column) {
    checkOverviewSchema(info, column, lodDefs, supported, issues);
  }

  const primaryTypes = info.primaryColumn
    ? (info.geo?.columns?.[info.primaryColumn]?.geometry_types ?? [])
    : [];
  if (primaryTypes.some((type) => /^(Multi)?Point\b/.test(type))) {
    error("Point geometries must not declare overviews.");
  } else if (supported) {
    const family = (type: string) => (/Polygon/.test(type) ? "polygon" : /LineString/.test(type) ? "line" : null);
    const primaryFamilies = new Set(primaryTypes.map(family).filter((f) => f !== null));
    for (const lod of lodDefs) {
      const lodFamily = lod.geometryType ? family(lod.geometryType) : null;
      if (lodFamily && primaryFamilies.size > 0 && !primaryFamilies.has(lodFamily)) {
        error(`LoD ${lod.name} is ${lod.geometryType}, outside the primary geometry family.`);
      }
    }
  }

  return {
    column: typeof column === "string" ? column : "",
    encoding: typeof encoding === "string" ? encoding : "",
    supported,
    lods: lodDefs,
  };
}

function checkOverviewSchema(
  info: GeoParquetInfo,
  column: string,
  lods: LodDef[],
  supported: boolean,
  issues: Issue[],
) {
  const error = (message: string) => issues.push({ severity: "error", message });
  if (column === info.primaryColumn) {
    error(`overviews.column "${column}" must differ from the primary geometry column.`);
    return;
  }
  let root: SchemaTree;
  try {
    root = parquetSchema(info.metadata);
  } catch {
    return;
  }
  const node = root.children.find((child) => child.element.name === column);
  if (!node) {
    error(`overviews.column "${column}" is not a top-level column.`);
    return;
  }
  if (!supported) return;
  if (node.children.length === 0) {
    error(`overviews.column "${column}" must be a struct.`);
    return;
  }
  if (node.element.repetition_type !== "REQUIRED") {
    error(`overviews.column "${column}" must be a required struct.`);
  }
  const children = new Set(node.children.map((child) => child.element.name));
  for (const lod of lods) {
    if (!children.has(lod.name)) error(`LoD ${lod.name} has no child in "${column}".`);
  }
  const names = new Set(lods.map((lod) => lod.name));
  for (const child of children) {
    if (!names.has(child)) error(`"${column}.${child}" has no LoD metadata entry.`);
  }
}

/**
 * Coverage from column chunk statistics: a LoD's leaves must be entirely null after its
 * effective boundary. Inside it, a chunk without any non-null leaf means every row is
 * null or empty, which is legal only for null or empty primary geometries.
 */
function checkCoverage(info: GeoParquetInfo, overviews: OverviewsDef, issues: Issue[]) {
  let missingStats = false;
  for (const lod of overviews.lods) {
    const nonNullAfter: number[] = [];
    const emptyInside: number[] = [];
    for (const rg of info.rowGroups) {
      const leaves = rg.columns.filter(
        (column) => column.pathParts[0] === overviews.column && column.pathParts[1] === lod.name,
      );
      if (leaves.length === 0) continue;
      if (leaves.some((leaf) => leaf.nullCount === null)) {
        missingStats = true;
        continue;
      }
      const hasValues = leaves.some((leaf) => leaf.numValues > (leaf.nullCount ?? 0));
      if (rg.index > lod.effectiveEnd && hasValues) nonNullAfter.push(rg.index);
      if (rg.index <= lod.effectiveEnd && !hasValues) emptyInside.push(rg.index);
    }
    if (nonNullAfter.length) {
      issues.push({
        severity: "error",
        message: `LoD ${lod.name} has values after its effective boundary (RG ${lod.effectiveEnd}) in RG ${listIndices(nonNullAfter)}.`,
      });
    }
    if (emptyInside.length) {
      issues.push({
        severity: "warning",
        message: `LoD ${lod.name} has no coordinates in RG ${listIndices(emptyInside)}: every row there is null or empty, allowed only for null or empty primary geometries.`,
      });
    }
  }
  if (missingStats) {
    issues.push({
      severity: "info",
      message: "Some overview column chunks lack null_count statistics; their coverage was not checked.",
    });
  }
}

function checkLayout(info: GeoParquetInfo, units: CrsUnits, issues: Issue[]) {
  const rowGroups = info.rowGroups;
  const noBBox = rowGroups.filter((rg) => !rg.bbox).length;
  if (noBBox > 0) {
    issues.push({
      severity: "warning",
      message: `${noBBox} of ${rowGroups.length} row group(s) have no bbox statistics; readers cannot prune them spatially.`,
    });
  }
  if (info.coveringRoots.length > 0) {
    const withPageIndex = rowGroups.filter((rg) =>
      rg.columns.some((c) => info.coveringRoots.includes(c.pathParts[0]) && c.hasPageIndex),
    ).length;
    issues.push({
      severity: withPageIndex === rowGroups.length ? "info" : "warning",
      message: `${withPageIndex} of ${rowGroups.length} row group(s) have Page Indexes on the bbox covering.`,
    });
  }
  let outOfOrder = 0;
  for (let i = 1; i < rowGroups.length; i++) {
    const a = rowGroups[i - 1].byteStart;
    const b = rowGroups[i].byteStart;
    if (a !== null && b !== null && b < a) outOfOrder++;
  }
  if (outOfOrder > 0) {
    issues.push({
      severity: "info",
      message: `Row group bytes are not stored in footer order (${outOfOrder} backward step(s)).`,
    });
  }
  if (units.kind === "unknown" || units.kind === "other") {
    issues.push({
      severity: "info",
      message: `CRS units (${units.label}) are not mapped to map zoom; zoom estimates are unavailable.`,
    });
  }
}

function analyzeLevels(
  info: GeoParquetInfo,
  levels: LevelDef[],
  overviews: OverviewsDef | null,
  breakdown: ByteBreakdown[],
  units: CrsUnits,
): LevelAnalysis[] {
  const rowGroups = info.rowGroups;
  const out: LevelAnalysis[] = [];
  let previousEnd = -1;
  let cumulativeRows = 0;
  let cumulativeBytes = 0;
  for (const [index, level] of levels.entries()) {
    const end = Math.min(level.rowGroupEnd, rowGroups.length - 1);
    const first = previousEnd + 1;
    const added = rowGroups.slice(first, end + 1);
    const newRows = added.reduce((sum, rg) => sum + rg.numRows, 0);
    const newBytes = added.reduce((sum, rg) => sum + rg.totalCompressedBytes, 0);
    cumulativeRows += newRows;
    cumulativeBytes += newBytes;
    const lod = overviews?.lods.find((l) => l.levelIndices.includes(index))?.name ?? null;

    const prefix: ByteBreakdown = {
      primary: 0,
      overview: 0,
      overviewByLod: {},
      covering: 0,
      attribute: 0,
      total: 0,
    };
    for (let rg = 0; rg <= end; rg++) {
      const b = breakdown[rg];
      prefix.primary += b.primary;
      prefix.covering += b.covering;
      prefix.attribute += b.attribute;
      prefix.total += b.total;
      prefix.overview += lod ? (b.overviewByLod[lod] ?? 0) : 0;
    }

    const bboxes = added.map((rg) => rg.bbox).filter((b): b is BBox => b !== null);
    const newBBox = unionBBox(bboxes);
    const unionArea = newBBox ? area(newBBox) : 0;
    const overlap =
      bboxes.length > 1 && unionArea > 0
        ? bboxes.reduce((sum, b) => sum + area(b), 0) / unionArea
        : null;

    out.push({
      index,
      resolution: level.resolution,
      rowGroupEnd: level.rowGroupEnd,
      firstNewRowGroup: first,
      newRowGroups: Math.max(0, end - previousEnd),
      newRows,
      cumulativeRows,
      newBytes,
      cumulativeBytes,
      lod,
      zoomFrom: index === 0 ? null : zoomForResolution(level.resolution, units),
      zoomTo: index === levels.length - 1 ? null : zoomForResolution(levels[index + 1].resolution, units),
      newBBox,
      overlap,
      prefix,
    });
    previousEnd = Math.max(previousEnd, end);
  }
  return out;
}

export function crsUnits(crs: ProjJson | string | null | undefined, hasPrimary: boolean): CrsUnits {
  // GeoParquet treats an absent CRS as OGC:CRS84; an explicit null means unknown.
  if (crs === undefined) {
    return hasPrimary
      ? { kind: "degree", label: "degree", metresPerUnit: METRES_PER_DEGREE, webMercator: false }
      : { kind: "unknown", label: "unknown", metresPerUnit: null, webMercator: false };
  }
  if (crs === null || typeof crs === "string") {
    return { kind: "unknown", label: "unknown", metresPerUnit: null, webMercator: false };
  }
  const source = crs.type === "BoundCRS" && crs.source_crs ? crs.source_crs : crs;
  const code = source.id && String(source.id.authority).toUpperCase() === "EPSG" ? Number(source.id.code) : null;
  const webMercator = code !== null && WEB_MERCATOR_EPSG.has(code);
  const unit = source.coordinate_system?.axis?.[0]?.unit;
  const name = typeof unit === "string" ? unit : (unit as { name?: string } | undefined)?.name;
  const factor = (unit as { conversion_factor?: number } | undefined)?.conversion_factor;
  if (name === "degree" || (code !== null && GEOGRAPHIC_EPSG.has(code)) || source.type === "GeographicCRS") {
    return { kind: "degree", label: "degree", metresPerUnit: METRES_PER_DEGREE, webMercator: false };
  }
  if (name === "metre" || name === "meter" || webMercator) {
    return { kind: "metre", label: "metre", metresPerUnit: 1, webMercator };
  }
  if (typeof factor === "number" && factor > 0 && (unit as { type?: string }).type === "LinearUnit") {
    return { kind: "other", label: name ?? "linear unit", metresPerUnit: factor, webMercator: false };
  }
  return { kind: "unknown", label: name ?? "unknown", metresPerUnit: null, webMercator: false };
}

/** Map zoom (512px tiles) at which the equatorial ground resolution equals `resolution`. */
export function zoomForResolution(resolution: number, units: CrsUnits): number | null {
  if (units.metresPerUnit === null) return null;
  return Math.log2(WEB_MERCATOR_CIRCUMFERENCE_M / (TILE_SIZE * resolution * units.metresPerUnit));
}

/**
 * Target resolution, in CRS units per pixel, for a tile zoom and latitude. Matches
 * @cogp/maplibre for degrees; Web Mercator metres are not scaled by latitude.
 */
export function targetResolution(tileZoom: number, latitude: number, units: CrsUnits): number | null {
  if (units.metresPerUnit === null) return null;
  const scale = units.webMercator ? 1 : Math.cos((latitude * Math.PI) / 180);
  return (WEB_MERCATOR_CIRCUMFERENCE_M * scale) / (TILE_SIZE * 2 ** tileZoom) / units.metresPerUnit;
}

/** The finest level whose resolution is at least the target, clamped to the first level. */
export function selectLevel(levels: LevelDef[], target: number): number {
  let chosen = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].resolution >= target) chosen = i;
    else break;
  }
  return chosen;
}

export interface ViewportQuery {
  level: number;
  lod: string | null;
  prefixEnd: number;
  /** Row groups in the prefix whose bbox intersects the viewport (or lacks a bbox). */
  hits: number[];
  rows: number;
  bytes: ByteBreakdown;
}

export function queryViewport(
  info: GeoParquetInfo,
  analysis: CogpAnalysis,
  level: number,
  viewport: BBox,
): ViewportQuery | null {
  const def = analysis.levelAnalyses[level];
  if (!def) return null;
  const prefixEnd = Math.min(def.rowGroupEnd, info.rowGroups.length - 1);
  const hits: number[] = [];
  let rows = 0;
  const bytes: ByteBreakdown = {
    primary: 0,
    overview: 0,
    overviewByLod: {},
    covering: 0,
    attribute: 0,
    total: 0,
  };
  for (let i = 0; i <= prefixEnd; i++) {
    const rg = info.rowGroups[i];
    if (rg.bbox && !bboxesIntersect(rg.bbox, viewport)) continue;
    hits.push(i);
    rows += rg.numRows;
    const b = analysis.breakdown[i];
    bytes.primary += b.primary;
    bytes.covering += b.covering;
    bytes.attribute += b.attribute;
    bytes.total += b.total;
    if (def.lod) bytes.overview += b.overviewByLod[def.lod] ?? 0;
  }
  return { level, lod: def.lod, prefixEnd, hits, rows, bytes };
}

function lngLatProjection(
  units: CrsUnits,
): { toLngLat: (b: BBox) => BBox; fromLngLat: (b: BBox) => BBox } | null {
  if (units.kind === "degree") return { toLngLat: (b) => b, fromLngLat: (b) => b };
  if (!units.webMercator) return null;
  const lng = (x: number) => (x / EARTH_RADIUS_M) * (180 / Math.PI);
  const lat = (y: number) => (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI);
  const x = (lon: number) => (lon * Math.PI * EARTH_RADIUS_M) / 180;
  const y = (la: number) => {
    const clamped = Math.max(-85.0511, Math.min(85.0511, la));
    return EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  };
  return {
    toLngLat: (b) => ({ xmin: lng(b.xmin), ymin: lat(b.ymin), xmax: lng(b.xmax), ymax: lat(b.ymax) }),
    fromLngLat: (b) => ({ xmin: x(b.xmin), ymin: y(b.ymin), xmax: x(b.xmax), ymax: y(b.ymax) }),
  };
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !(a.xmax < b.xmin || a.xmin > b.xmax || a.ymax < b.ymin || a.ymin > b.ymax);
}

function unionBBox(bboxes: BBox[]): BBox | null {
  if (bboxes.length === 0) return null;
  return bboxes.reduce((u, b) => ({
    xmin: Math.min(u.xmin, b.xmin),
    ymin: Math.min(u.ymin, b.ymin),
    xmax: Math.max(u.xmax, b.xmax),
    ymax: Math.max(u.ymax, b.ymax),
  }));
}

function area(b: BBox): number {
  return Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
}

function isPair(value: unknown, positive: boolean): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v) && (!positive || v > 0))
  );
}

function listIndices(indices: number[], max = 8): string {
  const shown = indices.slice(0, max).join(", ");
  return indices.length > max ? `${shown}, … (${indices.length} total)` : shown;
}

/** Sequential ramp from coarse (deep blue) to fine (red). */
const LEVEL_RAMP = [
  [44, 123, 182],
  [0, 166, 202],
  [0, 204, 188],
  [144, 235, 157],
  [255, 223, 100],
  [249, 168, 74],
  [231, 104, 24],
  [215, 25, 28],
];

export function levelColor(level: number, count: number): string {
  const t = count <= 1 ? 0 : level / (count - 1);
  const position = t * (LEVEL_RAMP.length - 1);
  const i = Math.min(Math.floor(position), LEVEL_RAMP.length - 2);
  const f = position - i;
  const [r, g, b] = LEVEL_RAMP[i].map((c, k) => Math.round(c + (LEVEL_RAMP[i + 1][k] - c) * f));
  return `rgb(${r}, ${g}, ${b})`;
}
