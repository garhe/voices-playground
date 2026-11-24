import { filterValues } from '../shared/filterSelection';
import { MultiFilter } from './MultiFilter';
import type { ArenaDetailSelection, arenaDetailOptions } from './arenaDetails';

export function ArenaDetailFilters({ selection, domains, options, onChange }: {
  selection: ArenaDetailSelection;
  domains: string[];
  options: ReturnType<typeof arenaDetailOptions>;
  onChange: (change: Partial<ArenaDetailSelection>) => void;
}) {
  return <>
    <MultiFilter label="Report domain" all="All domains" value={filterValues(selection.domain)} options={domains} onChange={domain => onChange({ domain })} />
    <MultiFilter label="Voice" all="All voices" value={filterValues(selection.voice)} options={options.voices} onChange={voice => onChange({ voice })} searchable />
    <MultiFilter label="Model" all="All models" value={filterValues(selection.model)} options={options.models} onChange={model => onChange({ model })} />
    <MultiFilter label="Script locale" all="All script locales" value={filterValues(selection.locale)} options={options.locales} onChange={locale => onChange({ locale })} searchable />
    <MultiFilter label="Gender" all="All genders" value={filterValues(selection.gender)} options={options.genders} onChange={gender => onChange({ gender })} />
  </>;
}
