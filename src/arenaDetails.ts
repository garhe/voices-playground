import { voiceGenders } from '../shared/domain';
import type { ArenaCell } from '../shared/arena';
import { matchesFilter, type FilterSelection } from '../shared/filterSelection';

export type ArenaDetailSelection = {
  domain: FilterSelection; voice: FilterSelection; model: FilterSelection; locale: FilterSelection; gender?: FilterSelection; identity?: string;
};

export function arenaVoiceName(identity: string): string {
  const separator = identity.indexOf(':');
  return separator > 0 ? identity.slice(0, separator) : identity;
}

export function arenaDetailOptions(cells: readonly ArenaCell[]) {
  return {
    voices: [...new Set(cells.map(cell => arenaVoiceName(cell.voice)))].sort(),
    models: [...new Set(cells.map(cell => cell.model))].sort(),
    locales: [...new Set(cells.map(cell => cell.locale))].sort(),
    genders: voiceGenders.filter(gender => cells.some(cell => cell.gender === gender)),
  };
}

export function arenaDetailSelectionForCell(cell: ArenaCell): ArenaDetailSelection {
  return { domain: cell.domain, voice: arenaVoiceName(cell.voice), model: cell.model, locale: cell.locale, identity: cell.voice };
}

export function arenaDetailMatches(cells: readonly ArenaCell[], selection: ArenaDetailSelection): ArenaCell[] {
  return cells.filter(cell => matchesFilter(selection.domain, domain => cell.domain === domain) &&
    matchesFilter(selection.voice, voice => arenaVoiceName(cell.voice) === voice) &&
    matchesFilter(selection.model, model => cell.model === model) && matchesFilter(selection.locale, locale => cell.locale === locale) &&
    matchesFilter(selection.gender, gender => cell.gender === gender));
}

export function arenaDetailKey(cell: ArenaCell): string {
  return JSON.stringify([cell.domain, cell.locale, cell.voice, cell.model]);
}
