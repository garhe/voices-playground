import { useId, useRef, useState } from 'react';

type Option<T> = T | { value: T; label: string };

export function MultiFilter<T extends string>({ label, all, options, value, onChange, disabled, searchable }: {
  label: string; all: string; options: readonly Option<T>[]; value: readonly T[]; onChange: (value: T[]) => void;
  disabled?: boolean; searchable?: boolean;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const choices = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  const missing = value.filter(item => !choices.some(option => option.value === item));
  const selectedLabel = value.length === 0 ? all : value.length === 1
    ? choices.find(option => option.value === value[0])?.label ?? value[0] : `${value.length} selected`;
  const visible = [...choices, ...missing.map(item => ({ value: item, label: `${item} (not available)` }))]
    .filter(option => `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="multi-filter">
    <span id={`${id}-label`}>{label}</span>
    <button type="button" className="secondary multi-filter-trigger" popoverTarget={id}
      aria-labelledby={`${id}-label ${id}-value`} disabled={disabled || (!choices.length && !value.length)}
      onClick={event => {
        const element = popup.current;
        if (!element || element.matches(':popover-open')) return;
        setQuery('');
        const rect = event.currentTarget.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, 224), document.documentElement.clientWidth - 16);
        const below = window.innerHeight - rect.bottom;
        const above = rect.top;
        const openUp = below < 280 && above > below;
        Object.assign(element.style, {
          width: `${width}px`,
          left: `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8))}px`,
          top: openUp ? 'auto' : `${rect.bottom + 4}px`,
          bottom: openUp ? `${window.innerHeight - rect.top + 4}px` : 'auto',
          maxHeight: `${Math.min(300, (openUp ? above : below) - 12)}px`,
        });
      }}>
      <span id={`${id}-value`} title={selectedLabel}>{selectedLabel}</span><span aria-hidden="true">▾</span>
    </button>
    <div id={id} ref={popup} className="multi-filter-popup" popover="auto" role="group" aria-labelledby={`${id}-label`}>
      {searchable && <input type="search" aria-label={`Search ${label.toLowerCase()} options`} placeholder="Search options" value={query} onChange={event => setQuery(event.target.value)} />}
      <button type="button" className="text-button" disabled={disabled || !value.length} onClick={() => onChange([])}>{all}</button>
      {visible.map(option => <label key={option.value}><input type="checkbox" checked={value.includes(option.value)} disabled={disabled}
        onChange={event => onChange(event.target.checked ? [...value, option.value] : value.filter(item => item !== option.value))} />{option.label}</label>)}
      {!visible.length && <p role="status">No matching options.</p>}
    </div>
  </div>;
}
