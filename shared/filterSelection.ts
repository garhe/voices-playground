export type FilterSelection<T extends string = string> = T | '' | readonly T[];

export function filterValues<T extends string>(selection: FilterSelection<T> | undefined): readonly T[] {
  return typeof selection === 'string' ? (selection ? [selection] : []) : selection ?? [];
}

export function matchesFilter<T extends string>(selection: FilterSelection<T> | undefined, matches: (value: T) => boolean): boolean {
  const values = filterValues(selection);
  return !values.length || values.some(matches);
}
