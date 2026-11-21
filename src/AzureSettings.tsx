import { useEffect, useState, type FormEvent } from 'react';
import { foundryResponsesEndpointSchema, scriptSettingsSchema, type ScriptDeploymentSettings } from '../shared/scriptGeneration';
import type { StudioSpeechStatus, StudioVoice } from '../shared/studio';

export type AppRequest = <T>(url: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;
export type AzureSettingsTarget = 'azure-openai' | 'azure-realtime' | 'azure-text' | 'azure-speech';
type Action = (label: string, fn: () => Promise<void>) => Promise<void>;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unexpected settings error.';

export function azureSettingsStatus(configured: boolean, source: 'saved' | 'environment' | 'none', detail?: string) {
  if (!configured) return 'Setup required';
  const label = source === 'saved' ? 'Saved locally' : source === 'environment' ? 'From environment' : 'Configured';
  return detail ? `${label} · ${detail}` : label;
}

export function AzureSettingsHeading({ id, title, status }: { id: AzureSettingsTarget; title: string; status?: string }) {
  return <div className="section-with-action azure-settings-card-heading">
    <h2 id={id} tabIndex={-1}>{title}</h2>
    {status && <span className="pill">{status}</span>}
  </div>;
}

export function useAzureSetting<T>(request: AppRequest, url: string) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request<T>(url, undefined, 'GET', controller.signal).then(result => {
      if (!controller.signal.aborted) { setValue(result); setError(''); }
    }, problem => {
      if (!controller.signal.aborted) setError(errorText(problem));
    });
    return () => controller.abort();
  }, [request, url, revision]);
  return { value, setValue, error, retry: () => { setError(''); setRevision(previous => previous + 1); } };
}

export function SpeechConnectionSettings({ request, status, busy, onAction, onSaved }: {
  request: AppRequest; status: StudioSpeechStatus; busy: boolean; onAction: Action;
  onSaved: (status: StudioSpeechStatus) => void;
}) {
  const [region, setRegion] = useState(status.region);
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const unsaved = region.trim() !== status.region || endpoint.trim() !== status.endpoint || !!key.trim();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    void onAction('Saving Azure Speech connection', async () => {
      const value = await request<StudioSpeechStatus>('/api/studio/connection', {
        region: region.trim(), endpoint: endpoint.trim(), apiKey: key.trim(),
      }, 'PUT');
      setRegion(value.region); setEndpoint(value.endpoint); setKey(''); setConfirmRemove(false);
      onSaved(value); setMessage('Azure Speech connection saved.');
    });
  }

  return <form onSubmit={save}>
    <p className="hint">Azure Voices Studio uses Speech for synthesis. Script Generation uses the same Speech connection for its locale list. Speech and Azure OpenAI use different credentials; saved keys are encrypted for your Windows account.</p>
    <div className="field-row">
      <label>Speech region<input value={region} required disabled={busy} placeholder="eastus" onChange={event => { setRegion(event.target.value); setMessage(''); }} /></label>
      <label>Custom resource endpoint (optional)<input type="url" value={endpoint} disabled={busy} placeholder="https://your-resource.cognitiveservices.azure.com" onChange={event => { setEndpoint(event.target.value); setMessage(''); }} /></label>
      <label>Speech key<input type="password" value={key} disabled={busy} autoComplete="new-password" placeholder={status.configured ? 'Leave blank to keep current key' : 'Key 1 or 2'} onChange={event => { setKey(event.target.value); setMessage(''); }} /></label>
    </div>
    <div className="button-row">
      <button className="secondary" type="submit" disabled={busy || !region.trim() || (!status.configured && !key.trim())}>Save Speech connection</button>
      <button className="secondary" type="button" disabled={busy || !status.configured || unsaved} onClick={() => {
        setMessage('');
        void onAction('Testing Azure Speech connection', async () => {
          const voices = await request<StudioVoice[]>('/api/studio/voices?refresh=1');
          onSaved({ ...status });
          setMessage(`Azure Speech connected. ${voices.length} voices returned; no audio was synthesized.`);
        });
      }}>Test Speech connection</button>
      {status.source === 'saved' && !confirmRemove && <button className="text-button danger" type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove saved Speech connection</button>}
    </div>
    {confirmRemove && <div className="connection-remove">
      <p className="hint">Remove the encrypted Speech key and saved settings? Environment settings will be used if present.</p>
      <div className="button-row">
        <button className="secondary danger" type="button" disabled={busy} onClick={() => {
          setMessage('');
          void onAction('Removing Azure Speech connection', async () => {
            const value = await request<StudioSpeechStatus>('/api/studio/connection', undefined, 'DELETE');
            setRegion(value.region); setEndpoint(value.endpoint); setKey(''); setConfirmRemove(false);
            onSaved(value); setMessage('Saved Azure Speech connection removed.');
          });
        }}>Confirm Speech removal</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep Speech connection</button>
      </div>
    </div>}
    {message && <p className="connection-success" role="status">{message}</p>}
  </form>;
}

export function TextDeploymentSettings({ request, settings, busy, onAction, onSaved }: {
  request: AppRequest; settings: ScriptDeploymentSettings; busy: boolean; onAction: Action;
  onSaved: (settings: ScriptDeploymentSettings) => void;
}) {
  const [deployment, setDeployment] = useState(settings.deployment);
  const [endpoint, setEndpoint] = useState(settings.foundry?.endpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [savedNow, setSavedNow] = useState(false);
  const useFoundry = !!endpoint.trim();
  const parsedEndpoint = useFoundry ? foundryResponsesEndpointSchema.safeParse(endpoint) : undefined;
  const keepKey = !!settings.foundry && !!parsedEndpoint?.success && parsedEndpoint.data === settings.foundry.endpoint;
  const unchanged = deployment.trim() === settings.deployment && (useFoundry === !!settings.foundry) && (!useFoundry || (keepKey && !apiKey.trim()));
  return <form onSubmit={event => {
    event.preventDefault();
    setSavedNow(false);
    void onAction('Saving text deployment', async () => {
      const input = scriptSettingsSchema.safeParse({ deployment, ...(useFoundry && { foundry: { endpoint, apiKey } }) });
      if (!input.success) throw new Error(input.error.issues[0].message);
      const value = await request<ScriptDeploymentSettings>('/api/script-generation/settings', input.data, 'PUT');
      setDeployment(value.deployment); setEndpoint(value.foundry?.endpoint ?? ''); setApiKey(''); onSaved(value); setSavedNow(true);
    });
  }}>
    <p className="hint">These settings apply only to Script Generation. Use a deployment that supports JSON mode.</p>
    <label>Deployment name<input disabled={busy} value={deployment} onChange={event => { setDeployment(event.target.value); setSavedNow(false); }} required
      maxLength={120} placeholder="Enter the deployment name only" autoComplete="off" spellCheck={false} /></label>
    <label>Foundry endpoint (optional)<input type="url" disabled={busy} value={endpoint} onChange={event => {
      setEndpoint(event.target.value); setApiKey(''); setSavedNow(false);
    }} maxLength={300} placeholder="https://your-resource.services.ai.azure.com/openai/v1/responses" spellCheck={false}
      aria-describedby="script-endpoint-hint" aria-invalid={useFoundry && !parsedEndpoint?.success} /></label>
    <p className="hint" id="script-endpoint-hint">{useFoundry
      ? parsedEndpoint?.success ? 'Scripts will use this Foundry resource after you save.' : 'Enter an Azure Foundry HTTPS resource URL or its /openai/v1/responses endpoint.'
      : settings.foundry ? 'Saving with the endpoint blank switches to the shared Azure OpenAI connection and removes the saved Foundry key.'
        : 'Leave this blank to use the shared Azure OpenAI connection.'}</p>
    {parsedEndpoint?.success && <>
      <label>Foundry API key<input type="password" disabled={busy || !settings.secureStorageAvailable} value={apiKey} onChange={event => {
        setApiKey(event.target.value); setSavedNow(false);
      }}
        required={!keepKey} maxLength={512} autoComplete="new-password" placeholder={keepKey ? 'Leave blank to keep the saved key' : 'Enter the key for this Foundry resource'} /></label>
      <p className="hint">{settings.secureStorageAvailable ? 'Use the key for this Foundry resource. It is encrypted for your Windows account.'
        : 'Saving a separate Foundry key requires Windows user encryption.'}</p>
    </>}
    <div className="button-row">
      <button className="secondary" type="submit" disabled={busy || !deployment.trim() || (settings.source === 'saved' && unchanged)
        || (useFoundry && (!parsedEndpoint?.success || (!keepKey && !apiKey.trim()) || !settings.secureStorageAvailable))}>Save deployment</button>
      {savedNow && unchanged && <small role="status">Deployment saved on this computer.</small>}
    </div>
  </form>;
}
