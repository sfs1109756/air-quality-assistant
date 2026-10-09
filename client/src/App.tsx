import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, getJSON, postJSON } from './api';
import { AiNotice, AiStatus, useHealth } from './components/AiStatus';
import { AnswerCard } from './components/AnswerCard';
import { DataSource } from './components/DataSource';
import { Insights } from './components/Insights';
import { Overview } from './components/Overview';
import type { AskResult } from './types';

interface Preset {
  id: string;
  question: string;
}

const EXAMPLES = [
  'When was CO2 highest in the conference room yesterday?',
  'Compare average PM2.5 on weekdays vs weekends per room',
  'Which hours of the day is the cafeteria air worst?',
  'Show the open office temperature and humidity today',
];

export default function App() {
  const health = useHealth();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<(AskResult & { key: number })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    getJSON<{ presets: Preset[] }>('/api/presets').then((d) => setPresets(d.presets)).catch(() => {});
  }, []);

  const push = (r: AskResult) => setAnswers((a) => [{ ...r, key: Date.now() }, ...a]);

  async function ask(e?: FormEvent, text = question) {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    try {
      // Send recent AI questions so follow-ups like "now only weekdays" have context.
      const history = answers
        .filter((a) => a.source !== 'preset')
        .slice(0, 3)
        .reverse()
        .map((a) => ({ question: a.question, sql: a.sql }));
      push(await postJSON<AskResult>('/api/ask', { question: q, history }));
      setQuestion('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.aiUnavailable
          ? `${err.message} Try one of the built-in questions — they work without AI.`
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function runPreset(p: Preset) {
    setBusy(true);
    setError('');
    try {
      push(await postJSON<AskResult>(`/api/presets/${p.id}`, {}));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function dataChanged() {
    setRefreshKey((k) => k + 1);
    setAnswers([]);
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>🌬️ Air Quality Assistant</h1>
          <p>Ask questions about your building's sensor data in plain English.</p>
        </div>
        <AiStatus health={health} />
      </header>

      <AiNotice health={health} />
      <DataSource refreshKey={refreshKey} onChanged={dataChanged} />
      <Overview refreshKey={refreshKey} />
      <Insights refreshKey={refreshKey} onAsk={(q) => ask(undefined, q)} aiReady={Boolean(health?.ok)} />

      <section className="ask">
        <form onSubmit={ask} className="ask-form">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Which room had the worst air quality this week?"
            disabled={busy}
          />
          <button disabled={busy || !question.trim() || !health?.ok}>
            {busy && <span className="spinner" />}
            Ask
          </button>
        </form>

        {health?.ok && (
          <div className="suggest">
            <span className="small muted">Try:</span>
            {EXAMPLES.map((q) => (
              <button key={q} type="button" className="chip btn" onClick={() => ask(undefined, q)} disabled={busy}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="suggest">
          <span className="small muted">Built-in (no AI):</span>
          {presets.map((p) => (
            <button key={p.id} type="button" className="chip btn" onClick={() => runPreset(p)} disabled={busy}>
              {p.question}
            </button>
          ))}
        </div>
        {busy && <p className="small muted"><span className="spinner" />Thinking… writing SQL and running it.</p>}
        {error && <div className="error">{error}</div>}
      </section>

      <section className="stack">
        {answers.map((a) => (
          <AnswerCard key={a.key} initial={a} aiReady={Boolean(health?.ok)} />
        ))}
      </section>
    </div>
  );
}
