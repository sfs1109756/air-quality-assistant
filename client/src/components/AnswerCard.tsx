import { useEffect, useState } from 'react';
import { postJSON, streamPost } from '../api';
import type { AskResult } from '../types';
import { prettyLabel, ResultChart } from './ResultChart';

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

export function AnswerCard({ initial, aiReady }: { initial: AskResult; aiReady: boolean }) {
  const [result, setResult] = useState(initial);
  const [answer, setAnswer] = useState(initial.answer ?? '');
  const [answering, setAnswering] = useState(false);

  // Stream the plain-English answer once the numbers are on screen.
  useEffect(() => {
    if (initial.answer || !aiReady || initial.rows.length === 0) return;
    const controller = new AbortController();
    setAnswering(true);
    streamPost(
      '/api/summarize',
      { question: initial.question, columns: initial.columns, rows: initial.rows.slice(0, 60), truncated: initial.truncated },
      setAnswer,
      controller.signal,
    )
      .then((d) => setAnswer(d.text))
      .catch(() => {
        /* the chart and table still answer the question */
      })
      .finally(() => setAnswering(false));
    return () => controller.abort();
  }, [initial, aiReady]);
  const [sql, setSql] = useState(initial.sql);
  const [showSql, setShowSql] = useState(false);
  const [showTable, setShowTable] = useState(initial.chart.type === 'none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function rerun() {
    setBusy(true);
    setError('');
    try {
      const r = await postJSON<Omit<AskResult, 'question' | 'chart' | 'answer'>>('/api/sql', { sql });
      setResult({ ...result, ...r, source: 'manual', answer: null, chart: result.chart });
      setAnswer(''); // the old answer described the old query
      setShowTable(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'air-quality-result.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <article className="panel answer">
      <div className="q">
        <span className="q-icon">?</span>
        {result.question}
        <span className={`chip src-${result.source}`}>
          {result.source === 'ai'
            ? `AI · ${result.attempts > 1 ? `fixed in ${result.attempts} tries` : '1st try'}`
            : result.source === 'preset'
              ? 'built-in'
              : 'edited SQL'}
        </span>
      </div>
      {result.notice && <div className="notice small">{result.notice}</div>}
      {answer && (
        <p className="a">
          {answer}
          {answering && <span className="caret" />}
        </p>
      )}
      {!answer && answering && (
        <p className="a muted">
          <span className="spinner" />
          Writing a summary…
        </p>
      )}
      {!answer && !answering && result.rows.length === 0 && <p className="a muted">No readings matched.</p>}

      <ResultChart spec={result.chart} rows={result.rows} />

      <div className="row answer-tools">
        <button className="ghost small" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide' : 'Show'} table ({result.rows.length}
          {result.truncated ? '+' : ''} rows)
        </button>
        <button className="ghost small" onClick={() => setShowSql((v) => !v)}>
          {showSql ? 'Hide' : 'View / edit'} SQL
        </button>
        <button className="ghost small" onClick={download} disabled={!result.rows.length}>
          CSV
        </button>
        <span className="small muted">{result.ms} ms</span>
      </div>

      {showSql && (
        <div className="sql-box">
          <textarea className="sql" value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          <div className="row">
            <button className="small" onClick={rerun} disabled={busy}>
              {busy && <span className="spinner" />}Run SQL
            </button>
            <span className="small muted">Read-only. Writes are blocked.</span>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {showTable && result.rows.length > 0 && (
        <div className="scroll-x table-wrap">
          <table className="data">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c} title={c}>
                    {prettyLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td key={c}>{String(r[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > 200 && <p className="small muted">Showing first 200 rows. Download CSV for all.</p>}
        </div>
      )}
    </article>
  );
}
