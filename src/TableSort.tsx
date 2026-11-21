import { useState, type ReactNode } from 'react';
import { compareTableValues, type SortDirection, type SortValue } from '../shared/tableSort';

type Sort = { key: string; direction: SortDirection };

export function SortHeader({ children, direction, onSort }: {
  children: ReactNode; direction?: SortDirection; onSort: () => void;
}) {
  return <th scope="col" aria-sort={direction} className="sortable-header">
    <button className="table-sort-button" type="button" onClick={onSort}>
      <span>{children}</span><span aria-hidden="true">{direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '↕'}</span>
    </button>
  </th>;
}

export function useTableSort(initial?: Sort) {
  const [sort, setSort] = useState(initial);
  return {
    header(key: string, label: ReactNode, first: SortDirection = 'ascending', afterSort?: () => void) {
      return <SortHeader key={key} direction={sort?.key === key ? sort.direction : undefined} onSort={() => {
        setSort(previous => ({ key, direction: previous?.key === key
          ? previous.direction === 'ascending' ? 'descending' : 'ascending'
          : first }));
        afterSort?.();
      }}>{label}</SortHeader>;
    },
    rows<Row>(rows: readonly Row[], values: Record<string, (row: Row) => SortValue>): readonly Row[] {
      const value = sort && values[sort.key];
      return sort && value
        ? rows.map(row => ({ row, value: value(row) })).sort((a, b) => compareTableValues(a.value, b.value, sort.direction)).map(item => item.row)
        : rows;
    },
  };
}
