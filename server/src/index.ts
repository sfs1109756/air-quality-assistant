import './env.js';
import { ask, runPreset, summarize, type HistoryItem } from './assistant.js';
import { ensureFreshData, readonlyDb, SCHEMA_SQL } from './db.js';
import { HttpError, asyncRoute, clip, createApp, finishApp } from './http.js';
import { LLMUnavailableError } from './llm.js';
import { findPreset, PRESETS } from './presets.js';
import { runReadOnly, UnsafeSqlError } from './sqlGuard.js';

ensureFreshData(process.argv.includes('--reseed'));

const app = createApp();

/** Latest reading + 24h averages per room, for the overview cards (no AI). */
app.get('/api/overview', (_req, res) => {
  const rows = readonlyDb()
    .prepare(
      `WITH latest AS (
         SELECT device_id, MAX(ts) AS ts FROM readings GROUP BY device_id
       )
       SELECT d.id, d.room, d.floor, d.zone, r.ts, r.pm25, r.pm10, r.co2, r.tvoc, r.temperature, r.humidity,
              (SELECT ROUND(AVG(pm25), 1) FROM readings x WHERE x.device_id = d.id AND x.ts >= datetime(l.ts, '-1 day')) AS pm25_24h,
              (SELECT ROUND(AVG(co2)) FROM readings x WHERE x.device_id = d.id AND x.ts >= datetime(l.ts, '-1 day')) AS co2_24h,
              (SELECT MAX(co2) FROM readings x WHERE x.device_id = d.id AND x.ts >= datetime(l.ts, '-1 day')) AS co2_peak_24h
       FROM devices d
       JOIN latest l ON l.device_id = d.id
       JOIN readings r ON r.device_id = d.id AND r.ts = l.ts
       ORDER BY d.floor, d.room`,
    )
    .all();
  res.json({ rooms: rows });
});

app.get('/api/presets', (_req, res) => {
  res.json({ presets: PRESETS.map(({ id, question }) => ({ id, question })) });
});

app.get('/api/schema', (_req, res) => res.json({ schema: SCHEMA_SQL.trim() }));

/** Built-in question — works with AI off. Adds an AI summary if a model is available. */
app.post(
  '/api/presets/:id',
  asyncRoute(async (req, res) => {
    const preset = findPreset(String(req.params.id));
    if (!preset) throw new HttpError(404, 'Unknown preset.');
    const result = runPreset(preset);
    if (req.body?.summarize !== false) {
      result.answer = await summarize(preset.question, preset.sql, result).catch(() => null);
    }
    res.json(result);
  }),
);

/** Natural-language question → SQL → result → chart + answer. */
app.post(
  '/api/ask',
  asyncRoute(async (req, res) => {
    const question = clip(req.body?.question, 500);
    if (question.length < 3) throw new HttpError(400, 'Ask a question about the air-quality data.');
    const history: HistoryItem[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((h: any) => h && typeof h.question === 'string' && typeof h.sql === 'string')
          .map((h: any) => ({ question: clip(h.question, 500), sql: clip(h.sql, 4000) }))
      : [];
    try {
      res.json(await ask(question, history));
    } catch (err) {
      // No AI? If the question is one of the built-ins, answer it anyway.
      const preset = findPreset(question);
      if (err instanceof LLMUnavailableError && preset) {
        res.json({ ...runPreset(preset), notice: 'AI is offline — showing the built-in query for this question.' });
        return;
      }
      if (err instanceof LLMUnavailableError) throw err;
      throw new HttpError(422, (err as Error).message);
    }
  }),
);

/** Run (edited) SQL directly — read-only, same guard as the AI path. */
app.post(
  '/api/sql',
  asyncRoute(async (req, res) => {
    const sql = clip(req.body?.sql, 8000);
    try {
      const result = runReadOnly(sql);
      res.json({ sql, ...result });
    } catch (err) {
      throw new HttpError(err instanceof UnsafeSqlError ? 400 : 422, (err as Error).message);
    }
  }),
);

app.post('/api/reseed', (_req, res) => {
  ensureFreshData(true);
  res.json({ ok: true });
});

finishApp(app);

const port = Number(process.env.PORT ?? 3002);
app.listen(port, () => console.log(`Air Quality Assistant API on http://localhost:${port}`));
