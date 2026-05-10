import type { ColumnStats, RowGroupInfo, StatRaw } from "./parquet.ts";

export type FilterOp = "eq" | "gte" | "lte" | "between" | "is_null" | "is_not_null";

export const FILTER_OPS: { value: FilterOp; label: string; needsValue: 0 | 1 | 2 }[] = [
  { value: "eq", label: "=", needsValue: 1 },
  { value: "gte", label: "≥", needsValue: 1 },
  { value: "lte", label: "≤", needsValue: 1 },
  { value: "between", label: "between", needsValue: 2 },
  { value: "is_null", label: "is null", needsValue: 0 },
  { value: "is_not_null", label: "is not null", needsValue: 0 },
];

export interface ColumnFilter {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  value2: string;
}

export function rowGroupMatchesFilters(rg: RowGroupInfo, filters: ColumnFilter[]): boolean {
  for (const f of filters) {
    const col = rg.columns.find((c) => c.path === f.column);
    if (!col) continue; // no metadata for this column → cannot prune
    if (!evaluate(col, f)) return false;
  }
  return true;
}

function evaluate(col: ColumnStats, f: ColumnFilter): boolean {
  switch (f.op) {
    case "is_null":
      // Keep if at least one value in this row group is null (or unknown).
      return col.nullCount === null || col.nullCount > 0;
    case "is_not_null": {
      // Keep if at least one value is non-null (or unknown).
      if (col.nullCount === null) return true;
      return col.numValues > col.nullCount;
    }
    case "eq": {
      const v = parseValue(f.value, col);
      if (v === null) return true;
      const min = col.minRaw;
      const max = col.maxRaw;
      if (min === null || max === null) return true;
      return cmp(min, v) <= 0 && cmp(max, v) >= 0;
    }
    case "gte": {
      const v = parseValue(f.value, col);
      if (v === null) return true;
      const max = col.maxRaw;
      if (max === null) return true;
      return cmp(max, v) >= 0;
    }
    case "lte": {
      const v = parseValue(f.value, col);
      if (v === null) return true;
      const min = col.minRaw;
      if (min === null) return true;
      return cmp(min, v) <= 0;
    }
    case "between": {
      const lo = parseValue(f.value, col);
      const hi = parseValue(f.value2, col);
      if (lo === null || hi === null) return true;
      const min = col.minRaw;
      const max = col.maxRaw;
      if (min === null || max === null) return true;
      return cmp(max, lo) >= 0 && cmp(min, hi) <= 0;
    }
  }
}

function parseValue(input: string, col: ColumnStats): StatRaw | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const ref = col.minRaw ?? col.maxRaw;
  if (ref === null) {
    const asNum = Number(trimmed);
    return Number.isFinite(asNum) ? asNum : trimmed;
  }
  if (typeof ref === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof ref === "bigint") {
    try {
      return BigInt(trimmed);
    } catch {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
  }
  if (typeof ref === "boolean") {
    if (/^(true|t|1|yes)$/i.test(trimmed)) return true;
    if (/^(false|f|0|no)$/i.test(trimmed)) return false;
    return null;
  }
  if (ref instanceof Date) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (ref instanceof Uint8Array) {
    return null; // Cannot meaningfully compare binary input.
  }
  // string
  return trimmed;
}

function cmp(a: StatRaw, b: StatRaw): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    const an = typeof a === "bigint" ? Number(a) : a;
    const bn = typeof b === "bigint" ? Number(b) : b;
    return an - bn;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // Mixed/unsupported types — treat as equal so the predicate doesn't prune.
  return 0;
}

export function makeId(): string {
  return `f${Math.random().toString(36).slice(2, 9)}`;
}
