import type { Job } from '../shared/domain';
import { voiceDescriptorRows } from '../shared/voiceDescriptorResults';
import { unassessedDescriptor, voiceDescriptorFields, voiceDescriptorKeys } from '../shared/voiceDescriptors';
import { useTableSort } from './TableSort';

type DescriptorRow = ReturnType<typeof voiceDescriptorRows>[number];

export function VoiceDescriptorReport({ job }: { job: Job }) {
  const sorting = useTableSort({ key: 'voice', direction: 'ascending' });
  const rows = sorting.rows(voiceDescriptorRows(job), {
    voice: row => row.voice, role: row => row.role,
    ...Object.fromEntries(voiceDescriptorKeys.map(key => [key, (row: DescriptorRow) => row.labels[key]])),
  });
  if (!rows.length) return null;
  const showRole = rows.some(row => row.role !== 'speaker');
  return <section className="card arena-card" aria-label="Top voice descriptors">
    <h2>Top voice descriptors</h2>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Voice descriptor results">
      <table>
        <thead><tr>{sorting.header('voice', 'Voice')}
          {showRole && sorting.header('role', 'Requested role')}
          {voiceDescriptorKeys.map(key => sorting.header(key, voiceDescriptorFields[key].label))}
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>
          <th scope="row">{row.voice}</th>
          {showRole && <td>{row.role}</td>}
          {voiceDescriptorKeys.map(key => <td key={key}>{row.labels[key] ?? unassessedDescriptor}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
