import { useEffect, useState } from 'react';
import { getJSON, postJSON, uploadFile } from '../api';

interface SourceInfo {
  source: { kind: 'demo' } | { kind: 'import'; file: string; at: string };
  readings: number;
  devices: number;
  from_ts: string | null;
  to_ts: string | null;
}

interface ImportResult {
  imported: number;
  skipped: number;
  devices: number;
  from: string;
  to: string;
  mapped: Record<string, string>;
  warnings: string[];
}

const day = (ts: string | null) =>
  ts ? new Date(ts.replace(' ', 'T')).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '–';

/** Shows where the data comes from; import your own CSV or go back to demo data. */
export function DataSource({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    getJSON<SourceInfo>('/api/data-source')
      .then(setInfo)
      .catch(() => {});
  }, [refreshKey]);

  async function onFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await uploadFile<ImportResult>('/api/import', file);
      const cols = Object.entries(r.mapped)
        .map(([k, v]) => `${v} → ${k}`)
        .join(', ');
      setMessage({
        kind: 'ok',
        text: `Imported ${r.imported.toLocaleString()} readings from ${r.devices} device${r.devices > 1 ? 's' : ''} (${r.from.slice(0, 10)} to ${r.to.slice(0, 10)}). Columns: ${cols}. ${r.warnings.join(' ')}`,
      });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function useDemo() {
    setBusy(true);
    setMessage(null);
    await postJSON('/api/reseed', {});
    setBusy(false);
    onChanged();
  }

  return (
    <div className="datasource">
      <div className="row ds-row">
        <span className="small">
          <strong>{info?.source.kind === 'import' ? `📄 ${info.source.file}` : '🧪 Demo data'}</strong>
          {info && (
            <span className="muted">
              {' '}
              · {info.readings.toLocaleString()} readings · {info.devices} devices · {day(info.from_ts)} – {day(info.to_ts)}
            </span>
          )}
        </span>
        <span className="row ds-actions">
          <label className="file small">
            {busy ? <span className="spinner" /> : '⇪'} Import CSV
            <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
          </label>
          <a className="small" href="/api/import/template">
            CSV template
          </a>
          <button className="ghost small" onClick={useDemo} disabled={busy} title="Regenerate 30 days of demo data ending now">
            {info?.source.kind === 'import' ? 'Back to demo data' : 'Refresh demo data'}
          </button>
        </span>
      </div>
      {message && <div className={message.kind === 'ok' ? 'notice small' : 'error small'}>{message.text}</div>}
    </div>
  );
}
