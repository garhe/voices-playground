import ExcelJS from 'exceljs';
import type { ArenaCell } from '../shared/arena';
import { activeDimensions, ARENA_RUBRIC, assessmentGaps, dimensionLabel, dimensions as ratingDimensions, summarize, summarizeVoiceEvidence, type Job } from '../shared/domain';
import { unassessedDescriptor, voiceDescriptorFields, voiceDescriptorKeys } from '../shared/voiceDescriptors';
import { voiceDescriptorRows } from '../shared/voiceDescriptorResults';
import { ttsIssueDetails, ttsIssueStatus, type TtsIssueSummary } from '../shared/ttsIssues';
import { arenaVoiceName } from './arenaDetails';
import type { ArenaComparisonView } from './ArenaDimensionComparison';

type Scorecard = { voices: readonly string[]; locales: readonly string[]; cells: ArenaCell[] };
type Sheet = ExcelJS.Worksheet;
type Value = string | number | null | undefined;
const identity = ['Voice / model', 'Script locale', 'Domain', 'Source test ID'];
const identityWidths = [42, 16, 23, 38];
const scoreFormat = '0.00';

function addSheet(book: ExcelJS.Workbook, name: string, headers: string[], widths: number[], fixed = 1) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: fixed }] });
  sheet.columns = headers.map((header, i) => ({ header, width: widths[i] ?? 17 }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  const row = sheet.getRow(1);
  row.height = 24;
  row.font = { color: { argb: 'FFFFFFFF' }, bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF205745' } };
  return sheet;
}

function addRow(sheet: Sheet, values: Value[]) {
  sheet.addRow(values.map(value => typeof value === 'string'
    ? value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '') : value));
}

export function arenaWorkbook({ voices, locales, cells }: Scorecard, jobs: ReadonlyMap<string, Job>) {
  const book = new ExcelJS.Workbook();
  const scorecard = addSheet(book, 'Scorecard', ['Voice / model', ...locales], [42]);
  const details = addSheet(book, 'Voice details', [
    ...identity, 'Model', 'Gender', 'Overall preference (1–5)', 'Fully assessed files', 'Total files',
    'Source test', 'Created (UTC)', 'Panel', 'Rubric', 'Scripts', ...voiceDescriptorKeys.map(key => voiceDescriptorFields[key].label),
  ], [...identityWidths, 27, 16, 24, 21, 14, 33, 27, 52, 27, 40]);
  const dimensions = addSheet(book, 'Dimension scores', [
    ...identity, 'Dimension', 'Full panel (1–5)', 'Judge', 'Deployment', 'Judge average (1–5)',
  ], [...identityWidths, 32, 21, 18, 26, 22]);
  const files = addSheet(book, 'Recording scores', [
    ...identity, 'Recording', 'Full panel (1–5)', 'Listening windows',
  ], [...identityWidths, 57, 21, 20]);
  const recordings = addSheet(book, 'Judge assessments', [
    ...identity, 'Recording', 'Window start (s)', 'Window end (s)', 'Channel', 'Judge', 'Deployment', 'Status',
    'Dimension', 'Rating (1–5)', 'Reason', 'Scoring gaps',
  ], [...identityWidths, 57, 17, 17, 12, 18, 26, 14, 32, 16, 72, 60]);
  const evidenceSheet = addSheet(book, 'Judge evidence', [
    ...identity, 'Judge', 'Deployment', 'Dimension', 'Evidence type', 'Comment', 'Source files',
  ], [...identityWidths, 18, 26, 32, 22, 72, 60]);

  const byCell = new Map(cells.map(cell => [JSON.stringify([cell.voice, cell.locale]), cell]));
  details.getColumn(7).numFmt = scoreFormat;
  dimensions.getColumn(6).numFmt = scoreFormat;
  dimensions.getColumn(9).numFmt = scoreFormat;
  files.getColumn(6).numFmt = scoreFormat;
  recordings.getColumn(13).numFmt = scoreFormat;
  for (let i = 0; i < locales.length; i++) scorecard.getColumn(i + 2).numFmt = scoreFormat;
  for (const voice of voices) {
    const row = locales.map(locale => byCell.get(JSON.stringify([voice, locale])));
    addRow(scorecard, [voice, ...row.map(cell => cell?.score)]);
    for (const cell of row) {
      if (!cell) continue;
      const job = jobs.get(cell.jobId);
      if (!job || job.status !== 'completed' || job.arena?.locale !== cell.locale || job.arena.domain !== cell.domain)
        throw new Error(`The saved test for ${voice} (${cell.locale}) changed. Refresh the scorecard and try again.`);
      const clips = job.clips.filter(clip => clip.voice === voice && clip.role === 'speaker');
      const clipIds = new Set(clips.map(clip => clip.id));
      const selected = { ...job, clips, results: job.results.filter(result => clipIds.has(result.clipId)) };
      const summary = summarize(selected)[0];
      if (!summary || summary.eligibleFiles !== summary.files || summary.files !== cell.files || summary.score !== cell.score)
        throw new Error(`The saved scores for ${voice} (${cell.locale}) changed. Refresh the scorecard and try again.`);
      const evidence = summarizeVoiceEvidence(selected)[0];
      const descriptors = voiceDescriptorRows(selected)[0]?.labels;
      const keys = [voice, cell.locale, cell.domain, cell.jobId];
      addRow(details, [...keys, cell.model, cell.gender, cell.score, summary.eligibleFiles, summary.files, job.name,
        cell.createdAt, cell.panel, cell.rubric, job.arena.scripts.join(', '), ...voiceDescriptorKeys.map(key => descriptors?.[key])]);

      const byFile = new Map<string, typeof clips>();
      for (const clip of clips) {
        const windows = byFile.get(clip.file) ?? [];
        windows.push(clip);
        byFile.set(clip.file, windows);
      }
      for (const [file, windows] of byFile) {
        const fileSummary = summarize({ ...selected, clips: windows })[0];
        addRow(files, [...keys, file, fileSummary.score, windows.length]);
      }
      const usedDimensions = activeDimensions(job.profile);
      const byJudge = new Map(evidence.judges.map(judge => [judge.judgeId, judge]));
      const byResult = new Map(selected.results.map(result => [JSON.stringify([result.clipId, result.judgeId]), result]));
      for (const judge of job.judges) {
        const judgeEvidence = byJudge.get(judge.id);
        const addNotes = (label: string | null, kind: string, notes: { text: string; files: string[] }[]) => {
          for (const note of notes) addRow(evidenceSheet, [...keys, judge.name, judge.deployment, label, kind, note.text, note.files.join('\n')]);
        };
        for (const dimension of usedDimensions) {
          const label = dimensionLabel(job.profile, dimension);
          const item = judgeEvidence?.dimensions.find(item => item.dimension === dimension);
          addRow(dimensions, [...keys, label, summary.dimensions[dimension], judge.name, judge.deployment, item?.score]);
          addNotes(label, 'Defect / improvement', item?.improvements ?? []);
        }
        addNotes(null, 'Scoring gap', judgeEvidence?.gaps ?? []);
        addNotes(null, 'Limitation', judgeEvidence?.limitations ?? []);
        addNotes(null, 'Observation', judgeEvidence?.observations ?? []);
        for (const clip of clips) {
          const result = byResult.get(JSON.stringify([clip.id, judge.id]));
          const gaps = assessmentGaps(result, job.profile, clip.role);
          for (const dimension of usedDimensions) {
            addRow(recordings, [...keys, clip.file, clip.start, clip.end, clip.channel, judge.name, judge.deployment,
              result?.status ?? 'missing', dimensionLabel(job.profile, dimension), result?.assessment?.scores[dimension],
              result?.assessment?.reasons[dimension], gaps.join('\n')]);
          }
        }
      }
    }
  }
  return book;
}

export async function exportArenaWorkbook(scorecard: Scorecard, load: (id: string) => Promise<Job>, domain: string) {
  const ids = [...new Set(scorecard.cells.map(cell => cell.jobId))];
  const jobs = new Map<string, Job>();
  for (let i = 0; i < ids.length; i += 3) {
    await Promise.all(ids.slice(i, i + 3).map(async id => jobs.set(id, await load(id))));
  }
  await downloadWorkbook(arenaWorkbook(scorecard, jobs), `voice-arena-${domain}.xlsx`);
}

export function arenaComparisonWorkbook(rows: readonly ArenaCell[], view: ArenaComparisonView) {
  const book = new ExcelJS.Workbook();
  const descriptors = view === 'descriptors';
  const headers = descriptors ? voiceDescriptorKeys.map(key => voiceDescriptorFields[key].label) :
    ['Overall preference', ...ratingDimensions.map(dimension => dimensionLabel({ rubric: ARENA_RUBRIC }, dimension))];
  const sheet = addSheet(book, descriptors ? 'Voice descriptors' : 'Scores',
    ['Voice', 'Model', 'Script locale', 'Gender', ...headers, 'Domain', 'Source test ID'],
    [27, 24, 16, 16, ...headers.map(label => Math.max(19, label.length + 3)), 24, 38]);
  if (!descriptors) {
    for (let column = 5; column < 5 + headers.length; column++) sheet.getColumn(column).numFmt = scoreFormat;
  }
  for (const cell of rows) {
    const values = descriptors
      ? voiceDescriptorKeys.map(key => cell.voiceDescriptors ? cell.voiceDescriptors[key] ?? unassessedDescriptor : 'Not collected')
      : [cell.score, ...ratingDimensions.map(dimension => cell.dimensionScores?.find(item => item.dimension === dimension)?.score)];
    addRow(sheet, [arenaVoiceName(cell.voice), cell.model, cell.locale, cell.gender, ...values, cell.domain, cell.jobId]);
  }
  return book;
}

export async function exportArenaComparison(rows: readonly ArenaCell[], view: ArenaComparisonView) {
  await downloadWorkbook(arenaComparisonWorkbook(rows, view), `voice-arena-comparison-${view}.xlsx`);
}

export function ttsDetailsWorkbook(voices: readonly TtsIssueSummary[], reportId: string) {
  const book = new ExcelJS.Workbook();
  const sheet = addSheet(book, 'TTS review details', [
    ...identity, 'Role', 'Review type', 'Dimension', 'Panel score (1–5)', 'Recording', 'Window start (s)',
    'Window end (s)', 'Source', 'Judge rating (1–5)', 'Observation', 'Listening cue', 'File coverage',
  ], [...identityWidths, 14, 26, 34, 22, 58, 18, 18, 20, 22, 75, 55, 20]);
  sheet.getColumn(8).numFmt = scoreFormat;
  sheet.getColumn(13).numFmt = scoreFormat;
  for (const voice of voices) {
    const keys = [voice.voice, voice.locale, voice.domain, reportId, voice.role];
    let hasDetails = false;
    for (const detail of ttsIssueDetails(voice)) {
      hasDetails = true;
      addRow(sheet, [...keys, detail.reviewType, detail.dimension, detail.score, detail.file, detail.start, detail.end,
        detail.judge, detail.rating, detail.observation, detail.cue,
        detail.fullyAssessed === undefined ? undefined : detail.fullyAssessed ? 'Fully assessed' : 'Incomplete']);
    }
    if (!hasDetails) addRow(sheet, [...keys, 'status', null, null, null, null, null, null, null, ttsIssueStatus(voice)]);
  }
  return book;
}

export async function exportTtsDetailsWorkbook(voices: readonly TtsIssueSummary[], reportId: string) {
  await downloadWorkbook(ttsDetailsWorkbook(voices, reportId), `tts-review-details-${reportId}.xlsx`);
}

async function downloadWorkbook(book: ExcelJS.Workbook, filename: string) {
  const data = await book.xlsx.writeBuffer();
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
