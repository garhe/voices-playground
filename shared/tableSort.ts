export type SortDirection = 'ascending' | 'descending';
export type SortValue = string | number | null | undefined;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareTableValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const missing = (value: SortValue) => value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
  if (missing(a)) return missing(b) ? 0 : 1;
  if (missing(b)) return -1;
  const order = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return direction === 'ascending' ? order : -order;
}
