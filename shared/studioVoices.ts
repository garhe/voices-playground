import type { StudioVoice } from './studio.js';
import { matchesFilter, type FilterSelection } from './filterSelection.js';

export type StudioVoiceFilters = {
  search: string;
  locales: string[];
  gender: FilterSelection;
  model: FilterSelection;
  styles: 'any' | 'with' | 'without';
};

export function studioVoiceLocales(voice: StudioVoice): string[] {
  const found = new Set<string>();
  return [voice.Locale, ...voice.SecondaryLocaleList].filter(locale => {
    const key = locale.toLowerCase();
    if (found.has(key)) return false;
    found.add(key);
    return true;
  });
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none', languageDisplay: 'standard' });

export function studioLocaleLabel(locale: string, name?: string): string {
  let fullName = name?.trim();
  if (!fullName) {
    try {
      fullName = languageNames.of(locale);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return fullName && fullName.toLowerCase() !== locale.toLowerCase() ? `${fullName} (${locale})` : locale;
}

export function studioLocaleOptions(voices: StudioVoice[]) {
  const names = new Map<string, string>();
  const codes = new Map<string, string>();
  for (const voice of voices) {
    const primary = voice.Locale.toLowerCase();
    if (voice.LocaleName?.trim() && !names.has(primary)) names.set(primary, voice.LocaleName);
    for (const locale of studioVoiceLocales(voice)) {
      const key = locale.toLowerCase();
      if (!codes.has(key)) codes.set(key, locale);
    }
  }
  return [...codes].map(([key, value]) => ({ value, label: studioLocaleLabel(value, names.get(key)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function studioVoiceModel(voice: Pick<StudioVoice, 'ShortName' | 'VoiceType'>): string {
  const suffix = voice.ShortName.split(':').slice(1).join(':');
  if (suffix) return suffix;
  if (/MultilingualNeural$/i.test(voice.ShortName)) return 'MultilingualNeural';
  return voice.VoiceType || (/Neural$/i.test(voice.ShortName) ? 'Neural' : 'Unspecified');
}

export type StudioVoiceSort = {
  key: 'voice' | 'language' | 'gender' | 'model' | 'localeCount';
  direction: 'ascending' | 'descending';
};

const catalogCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortStudioVoices(
  voices: readonly StudioVoice[], { key, direction }: StudioVoiceSort, localeLabel = studioLocaleLabel,
): StudioVoice[] {
  const value = (voice: StudioVoice) => {
    switch (key) {
      case 'voice': return voice.DisplayName;
      case 'language': return voice.LocaleName || localeLabel(voice.Locale);
      case 'gender': return voice.Gender;
      case 'model': return studioVoiceModel(voice);
      case 'localeCount': return studioVoiceLocales(voice).length;
    }
  };
  return voices.map(voice => ({ voice, value: value(voice) })).sort((a, b) => {
    const order = typeof a.value === 'number' && typeof b.value === 'number'
      ? a.value - b.value : catalogCollator.compare(String(a.value), String(b.value));
    return (direction === 'ascending' ? order : -order)
      || catalogCollator.compare(a.voice.DisplayName, b.voice.DisplayName)
      || a.voice.ShortName.localeCompare(b.voice.ShortName);
  }).map(entry => entry.voice);
}

export function studioVoiceMatches(voice: StudioVoice, filters: StudioVoiceFilters): boolean {
  const locales = studioVoiceLocales(voice);
  const model = studioVoiceModel(voice);
  const search = filters.search.trim().toLowerCase();
  return matchesFilter(filters.gender, gender => voice.Gender === gender)
    && matchesFilter(filters.model, selected => model === selected)
    && (!filters.locales.length || filters.locales.some(locale => locales.some(item => item.toLowerCase() === locale.toLowerCase())))
    && (filters.styles === 'any' || (filters.styles === 'with') === !!voice.StyleList?.length)
    && (!search || [voice.DisplayName, voice.ShortName, voice.LocaleName ?? '', voice.Gender, model, voice.VoiceType ?? '', ...locales]
      .some(value => value.toLowerCase().includes(search)));
}
