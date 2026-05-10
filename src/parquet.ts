import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync } from "hyparquet";
import type { AsyncBuffer, ColumnChunk, FileMetaData, RowGroup, Statistics } from "hyparquet";

export interface BBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export type StatRaw = number | bigint | string | Date | Uint8Array | boolean;

export interface ColumnStats {
  path: string;
  type: string;
  codec: string;
  numValues: number;
  compressedBytes: number;
  uncompressedBytes: number;
  min: string | null;
  max: string | null;
  minRaw: StatRaw | null;
  maxRaw: StatRaw | null;
  nullCount: number | null;
  distinctCount: number | null;
  geoBbox: BBox | null;
  geoTypes: number[] | null;
}

export interface RowGroupInfo {
  index: number;
  numRows: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  fileOffset: number | null;
  bbox: BBox | null;
  bboxSource: "native" | "covering" | "bbox-struct" | "unavailable";
  geometryTypes: number[] | null;
  columns: ColumnStats[];
}

export interface GeoParquetInfo {
  metadata: FileMetaData;
  primaryColumn: string | null;
  geoVersion: string | null;
  crs: string | null;
  rowGroups: RowGroupInfo[];
  warnings: string[];
}

const COVERING_KEYS = ["xmin", "ymin", "xmax", "ymax"] as const;
type CoveringKey = (typeof COVERING_KEYS)[number];
type CoveringPaths = Record<CoveringKey, string[]>;

interface GeoColumnDef {
  encoding?: string;
  geometry_types?: string[];
  bbox?: number[];
  crs?: { id?: { authority: string; code: string | number } };
  covering?: { bbox?: Record<string, string[]> };
}

interface GeoMetadata {
  version?: string;
  primary_column?: string;
  columns?: Record<string, GeoColumnDef>;
}

export async function loadFromUrl(url: string): Promise<GeoParquetInfo> {
  const raw = await asyncBufferFromUrl({ url });
  const buf = cachedAsyncBuffer(raw, { minSize: 1 << 16 });
  const metadata = await parquetMetadataAsync(buf);
  return analyze(metadata);
}

export async function loadFromFile(file: File): Promise<GeoParquetInfo> {
  const buf = fileAsAsyncBuffer(file);
  // Try the async path first; fall back to whole-file read for very small files.
  const metadata = await parquetMetadataAsync(buf);
  return analyze(metadata);
}

function fileAsAsyncBuffer(file: File): AsyncBuffer {
  return {
    byteLength: file.size,
    slice: async (start: number, end?: number): Promise<ArrayBuffer> => {
      const stop = end ?? file.size;
      return await file.slice(start, stop).arrayBuffer();
    },
  };
}

export function analyze(metadata: FileMetaData): GeoParquetInfo {
  const warnings: string[] = [];
  const geo = readGeoMetadata(metadata);

  let primaryColumn: string | null = null;
  let geoVersion: string | null = null;
  let crs: string | null = null;
  let coveringPaths: CoveringPaths | null = null;

  if (geo) {
    primaryColumn = geo.primary_column ?? null;
    geoVersion = geo.version ?? null;
    const primary = primaryColumn && geo.columns ? geo.columns[primaryColumn] : null;
    if (primary?.crs?.id) {
      crs = `${primary.crs.id.authority}:${primary.crs.id.code}`;
    } else if (primary) {
      crs = "OGC:CRS84";
    }
    if (primary?.covering?.bbox) {
      coveringPaths = pickCoveringPaths(primary.covering.bbox, warnings);
    }
  } else {
    warnings.push(
      'No "geo" metadata key found — file may not be GeoParquet. Attempting bbox struct fallback.',
    );
  }

  // Auto-detect bbox struct if no covering was declared.
  if (!coveringPaths) {
    coveringPaths = autodetectBboxStruct(metadata);
  }

  const rowGroups: RowGroupInfo[] = metadata.row_groups.map((rg, i) =>
    summarizeRowGroup(rg, i, primaryColumn, coveringPaths),
  );

  return {
    metadata,
    primaryColumn,
    geoVersion,
    crs,
    rowGroups,
    warnings,
  };
}

function readGeoMetadata(metadata: FileMetaData): GeoMetadata | null {
  const entry = metadata.key_value_metadata?.find((kv) => kv.key === "geo");
  if (!entry?.value) return null;
  try {
    return JSON.parse(entry.value) as GeoMetadata;
  } catch {
    return null;
  }
}

function pickCoveringPaths(
  raw: Record<string, string[]>,
  warnings: string[],
): CoveringPaths | null {
  const out: Partial<CoveringPaths> = {};
  for (const k of COVERING_KEYS) {
    const v = raw[k];
    if (!Array.isArray(v) || v.length === 0) {
      warnings.push(`covering.bbox.${k} missing in geo metadata`);
      return null;
    }
    out[k] = v;
  }
  return out as CoveringPaths;
}

function autodetectBboxStruct(metadata: FileMetaData): CoveringPaths | null {
  // Some writers expose a bbox struct without declaring it in covering.
  // Look for columns whose path matches ["bbox", "<key>"] (or top-level "*_bbox").
  const rg0 = metadata.row_groups[0];
  if (!rg0) return null;
  const paths = rg0.columns
    .map((c) => c.meta_data?.path_in_schema)
    .filter((p): p is string[] => Array.isArray(p));

  const found: Partial<CoveringPaths> = {};
  for (const p of paths) {
    if (p.length !== 2 || p[0] !== "bbox") continue;
    const leaf = p[1].toLowerCase();
    if (COVERING_KEYS.includes(leaf as CoveringKey)) {
      found[leaf as CoveringKey] = p;
    }
  }
  if (COVERING_KEYS.every((k) => found[k])) {
    return found as CoveringPaths;
  }
  return null;
}

function summarizeRowGroup(
  rg: RowGroup,
  index: number,
  primaryColumn: string | null,
  coveringPaths: CoveringPaths | null,
): RowGroupInfo {
  const numRows = Number(rg.num_rows);
  const totalCompressedBytes = sumColumns(rg, (m) => Number(m.total_compressed_size));
  const totalUncompressedBytes = sumColumns(rg, (m) => Number(m.total_uncompressed_size));
  const fileOffset = rg.file_offset !== undefined ? Number(rg.file_offset) : null;
  const columns: ColumnStats[] = rg.columns
    .map(extractColumnStats)
    .filter((c): c is ColumnStats => c !== null);

  let bbox: BBox | null = null;
  let bboxSource: RowGroupInfo["bboxSource"] = "unavailable";
  let geometryTypes: number[] | null = null;

  // Native GeoParquet 1.2 / Parquet 3 geospatial stats on the primary column.
  if (primaryColumn) {
    const native = findColumn(rg, [primaryColumn]);
    const nativeBbox = native?.meta_data?.geospatial_statistics?.bbox;
    if (nativeBbox && Number.isFinite(nativeBbox.xmin)) {
      bbox = {
        xmin: nativeBbox.xmin,
        ymin: nativeBbox.ymin,
        xmax: nativeBbox.xmax,
        ymax: nativeBbox.ymax,
      };
      bboxSource = "native";
      geometryTypes = native?.meta_data?.geospatial_statistics?.geospatial_types ?? null;
    }
  }

  if (!bbox && coveringPaths) {
    const fromCovering = bboxFromCovering(rg, coveringPaths);
    if (fromCovering) {
      bbox = fromCovering;
      bboxSource = coveringPathsLookLikeStruct(coveringPaths) ? "bbox-struct" : "covering";
    }
  }

  return {
    index,
    numRows,
    totalCompressedBytes,
    totalUncompressedBytes,
    fileOffset,
    bbox,
    bboxSource,
    geometryTypes,
    columns,
  };
}

function extractColumnStats(c: ColumnChunk): ColumnStats | null {
  const m = c.meta_data;
  if (!m) return null;
  const stats = m.statistics;
  const minRaw = stats?.min_value ?? stats?.min;
  const maxRaw = stats?.max_value ?? stats?.max;
  const geo = m.geospatial_statistics;
  return {
    path: m.path_in_schema.join("."),
    type: m.type,
    codec: m.codec,
    numValues: Number(m.num_values),
    compressedBytes: Number(m.total_compressed_size),
    uncompressedBytes: Number(m.total_uncompressed_size),
    min: formatStatValue(minRaw),
    max: formatStatValue(maxRaw),
    minRaw: toStatRaw(minRaw),
    maxRaw: toStatRaw(maxRaw),
    nullCount: stats?.null_count !== undefined ? Number(stats.null_count) : null,
    distinctCount: stats?.distinct_count !== undefined ? Number(stats.distinct_count) : null,
    geoBbox: geo?.bbox
      ? {
          xmin: geo.bbox.xmin,
          ymin: geo.bbox.ymin,
          xmax: geo.bbox.xmax,
          ymax: geo.bbox.ymax,
        }
      : null,
    geoTypes: geo?.geospatial_types ?? null,
  };
}

function toStatRaw(v: unknown): StatRaw | null {
  if (v === undefined || v === null) return null;
  if (
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "string" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  if (v instanceof Date) return v;
  if (v instanceof Uint8Array) return v;
  return null;
}

function formatStatValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return truncate(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    if (v.length <= 32) {
      return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return `<${v.length.toLocaleString()} bytes>`;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) return n.toExponential(4);
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function truncate(s: string, max = 64): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function coveringPathsLookLikeStruct(p: CoveringPaths): boolean {
  return COVERING_KEYS.every((k) => p[k][0] === "bbox" && p[k].length === 2);
}

function sumColumns(
  rg: RowGroup,
  pick: (m: NonNullable<ColumnChunk["meta_data"]>) => number,
): number {
  let total = 0;
  for (const c of rg.columns) {
    if (c.meta_data) total += pick(c.meta_data);
  }
  return total;
}

function findColumn(rg: RowGroup, path: string[]): ColumnChunk | undefined {
  return rg.columns.find((c) => pathEquals(c.meta_data?.path_in_schema, path));
}

function pathEquals(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bboxFromCovering(rg: RowGroup, paths: CoveringPaths): BBox | null {
  const get = (k: CoveringKey, side: "min" | "max"): number | null => {
    const col = findColumn(rg, paths[k]);
    const stats = col?.meta_data?.statistics;
    return statValue(stats, side);
  };
  const xmin = get("xmin", "min");
  const ymin = get("ymin", "min");
  const xmax = get("xmax", "max");
  const ymax = get("ymax", "max");
  if (
    xmin === null ||
    ymin === null ||
    xmax === null ||
    ymax === null ||
    !Number.isFinite(xmin) ||
    !Number.isFinite(ymin) ||
    !Number.isFinite(xmax) ||
    !Number.isFinite(ymax)
  ) {
    return null;
  }
  return { xmin, ymin, xmax, ymax };
}

function statValue(stats: Statistics | undefined, side: "min" | "max"): number | null {
  if (!stats) return null;
  const candidate =
    side === "min" ? (stats.min_value ?? stats.min) : (stats.max_value ?? stats.max);
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate === "number") return candidate;
  if (typeof candidate === "bigint") return Number(candidate);
  // Other types (string, Uint8Array, Date) aren't valid bbox coords.
  return null;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatBBox(b: BBox): string {
  const f = (n: number) => {
    const abs = Math.abs(n);
    if (abs === 0) return "0";
    if (abs < 0.01 || abs >= 100000) return n.toExponential(3);
    return n.toFixed(abs < 1 ? 5 : abs < 100 ? 4 : 2);
  };
  return `[${f(b.xmin)}, ${f(b.ymin)}, ${f(b.xmax)}, ${f(b.ymax)}]`;
}
