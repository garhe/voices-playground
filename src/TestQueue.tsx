import type { EvaluationWorkspace, QueuedTest, TestQueueState } from '../shared/domain';
import type { TestHistory } from '../shared/history';

export function queueForWorkspace(state: TestQueueState, history: TestHistory[], workspace: EvaluationWorkspace) {
  const workspaces = new Map(history.map(entry => [entry.id, entry.workspace]));
  const belongs = (entry: QueuedTest) => (entry.workspace ?? workspaces.get(entry.id)) === workspace;
  const active = state.active && belongs(state.active) ? state.active : undefined;
  const waiting = state.waiting.filter(belongs);
  return {
    state: { ...state, active, waiting },
    hiddenActive: !!state.active && !active,
    hiddenWaiting: state.waiting.length - waiting.length,
  };
}

export function TestQueue({ state, busy, onPause, onStart, onCancel, workspace, history = [] }: {
  state: TestQueueState; busy: boolean; onPause: () => void; onStart: () => void; onCancel: (id: string) => void;
  workspace?: EvaluationWorkspace; history?: TestHistory[];
}) {
  const view = workspace ? queueForWorkspace(state, history, workspace) : { state, hiddenActive: false, hiddenWaiting: 0 };
  const visible = view.state;
  if (!state.active && !state.waiting.length && !state.paused && !state.error) return null;
  return <section className="test-queue" aria-label="Test queue">
    <div className="test-queue-header">
      <strong>Test queue</strong>
      <span role="status">{state.recoveringSave ? 'Retrying local save' : visible.active ? `Running${visible.active.retry ? ' retry' : ''}: ${visible.active.name}` : view.hiddenActive ? 'Another or unclassified test is running' : 'No test running'} · {visible.waiting.length} waiting{view.hiddenWaiting > 0 ? ` · ${view.hiddenWaiting} other or unclassified waiting` : ''}{state.paused ? ' · Paused' : ''}</span>
      <div className="button-row">
        {visible.active && <button className="text-button danger" disabled={busy} onClick={() => onCancel(visible.active!.id)}>Cancel running test</button>}
        {state.paused
          ? <button className="secondary" disabled={busy || !state.waiting.length} onClick={onStart}>Start queue</button>
          : <button className="secondary" disabled={busy} onClick={onPause}>Pause queue</button>}
      </div>
    </div>
    {workspace && <p className="hint">Queue controls apply to both Voice Arena and Voices Scoring. Only this workspace's tests are listed here.</p>}
    {state.error && <p className="error-text" role="alert">{state.error}</p>}
    {!!visible.active?.autoRetryCount && <p role="status">Automatic retry {visible.active.autoRetryCount} · No attempt limit</p>}
    {state.paused && <p className="hint">The current test can finish; waiting tests will not start. After a server restart, start the saved queue explicitly.</p>}
    {!!visible.waiting.length && <details><summary>Waiting tests ({visible.waiting.length})</summary>
      <ol>{visible.waiting.map(test => <li key={test.id}><div className="test-queue-row"><span title={test.name}>{test.retry ? 'Retry: ' : ''}{test.name}</span>
        <button className="text-button danger" disabled={busy} aria-label={`Cancel queued test ${test.name}`} onClick={() => onCancel(test.id)}>Cancel</button></div>
        {!!test.autoRetryCount && <small>Automatic retry {test.autoRetryCount} · Later tests wait until this test finishes</small>}
      </li>)}</ol>
    </details>}
  </section>;
}
