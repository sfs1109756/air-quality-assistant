import './env.js';
import { ask, runPreset, summarize, type HistoryItem } from './assistant.js';
import { ensureFreshData, getDataSource, readonlyDb, SCHEMA_SQL } from './db.js';
import multer from 'multer';
import { HttpError, asyncRoute, clip, createApp, finishApp, rateLimit } from './http.js';
import { CSV_TEMPLATE, importCsv } from './importCsv.js';
import { computeInsights } from './insights.js';
import { LLMUnavailableError } from './llm.js';
import { findPreset, PRESETS } from './presets.js';
import { runReadOnly, UnsafeSqlError } from './sqlGuard.js';
import { streamText } from './stream.js';

ensureFreshData(process.argv.includes('--reseed'));

const app = createApp();
const aiLimit = rateLimit();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

/** Built-in question — works with AI off. The answer text is streamed separately via /api/summarize. */
app.post('/api/presets/:id', (req, res) => {
  const preset = findPreset(String(req.params.id));
  if (!preset) throw new HttpError(404, 'Unknown preset.');
  res.json(runPreset(preset));
});

/** Streams a short plain-English answer for a question and its result rows. */
app.post(
  '/api/summarize',
  aiLimit,
  asyncRoute(async (req, res) => {
    const question = clip(req.body?.question, 500);
    const columns: string[] = Array.isArray(req.body?.columns) ? req.body.columns.map(String).slice(0, 30) : [];
    const rows: Record<string, unknown>[] = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 60) : [];
    if (!question || columns.length === 0) throw new HttpError(400, 'Question and result columns are required.');
    await streamText(req, res, (emit, signal) => summarize(question, { columns, rows, truncated: Boolean(req.body?.truncated) }, emit, signal));
  }),
);

/** Rule-based weekly insights: ventilation, particles, anomalies, sensor health (no AI). */
app.get('/api/insights', (_req, res) => res.json(computeInsights()));

/** Where the data came from (demo generator or a CSV import) and its range. */
app.get('/api/data-source', (_req, res) => {
  const stats = readonlyDb()
    .prepare('SELECT COUNT(*) AS readings, (SELECT COUNT(*) FROM devices) AS devices, MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM readings')
    .get();
  res.json({ source: getDataSource(), ...(stats as object) });
});

app.get('/api/import/template', (_req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="air-quality-template.csv"');
  res.send(CSV_TEMPLATE);
});

/** Replace the data with readings from a CSV file. */
app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded.');
  try {
    res.json(importCsv(req.file.buffer.toString('utf8'), req.file.originalname));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

/** Natural-language question → SQL → result → chart + answer. */
app.post(
  '/api/ask',
  aiLimit,
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

export default app;
