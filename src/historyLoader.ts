import { testHistory, testNameMetadata, type TestHistory } from '../shared/history';
import type { EvaluationWorkspace, Job } from '../shared/domain';

export function workspaceHistory(entries: TestHistory[], workspace: EvaluationWorkspace): TestHistory[] {
  return entries.filter(entry => entry.workspace === workspace);
}

export function createHistoryLoader(
  loadList: (signal?: AbortSignal) => Promise<TestHistory[]>,
  loadJob: (id: string, signal?: AbortSignal) => Promise<Job>,
  loadArenaIds?: (signal?: AbortSignal) => Promise<string[]>,
) {
  const cache = new Map<string, { signature: string; incomplete: boolean }>();
  const knownArenaIds = new Set<string>();
  let classifiedLegacyIds: string | undefined;
  let generation = 0;
  return async (signal?: AbortSignal, refresh = false): Promise<TestHistory[]> => {
    if (refresh) { cache.clear(); classifiedLegacyIds = undefined; generation++; }
    const currentGeneration = generation;
    const entries = await loadList(signal);
    if (entries.some(entry => !Array.isArray(entry.languages) || !Array.isArray(entry.voices) || !Array.isArray(entry.genders)))
      throw new Error('The server is using an older test-list format. Restart Voices Selection, then refresh this page.');
    const legacyIds = entries.filter(entry => !entry.workspace).map(entry => entry.id).sort();
    const classificationKey = JSON.stringify(legacyIds);
    if (loadArenaIds && legacyIds.length && classifiedLegacyIds !== classificationKey) {
      const arenaIds = await loadArenaIds(signal);
      signal?.throwIfAborted();
      for (const id of arenaIds) knownArenaIds.add(id);
      if (currentGeneration === generation) classifiedLegacyIds = classificationKey;
    }
    const completed = new Set(entries.filter(entry => entry.status === 'completed' && typeof entry.incomplete !== 'boolean').map(entry => entry.id));
    for (const id of cache.keys()) if (!completed.has(id)) cache.delete(id);
    const resolved = new Array<TestHistory>(entries.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        signal?.throwIfAborted();
        const index = next++;
        const entry = entries[index];
        const normalized: TestHistory = {
          ...entry, ...testNameMetadata(entry.name),
          ...(loadArenaIds && !entry.workspace ? { workspace: knownArenaIds.has(entry.id) ? 'arena' : 'scoring' } : {}),
        };
        if (!completed.has(entry.id)) {
          resolved[index] = normalized;
          continue;
        }
        const signature = JSON.stringify(entry);
        const saved = cache.get(entry.id);
        if (saved?.signature === signature) {
          resolved[index] = { ...normalized, incomplete: saved.incomplete };
          continue;
        }
        const job = await loadJob(entry.id, signal);
        signal?.throwIfAborted();
        const summary = testHistory(job);
        if (currentGeneration === generation && summary.status === 'completed')
          cache.set(entry.id, { signature, incomplete: summary.incomplete === true });
        resolved[index] = summary;
      }
    }));
    return resolved;
  };
}
