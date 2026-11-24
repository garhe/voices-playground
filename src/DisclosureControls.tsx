export function DisclosureControls({ label, onChange }: { label: string; onChange: (open: boolean) => void }) {
  return <div className="button-row evidence-tree-actions" role="group" aria-label={`${label} controls`}>
    <button className="secondary" type="button" onClick={() => onChange(true)}>Expand all</button>
    <button className="secondary" type="button" onClick={() => onChange(false)}>Collapse all</button>
  </div>;
}

export function setDetailsOpen(container: HTMLElement | null, open: boolean) {
  container?.querySelectorAll<HTMLDetailsElement>('details').forEach(details => { details.open = open; });
}
