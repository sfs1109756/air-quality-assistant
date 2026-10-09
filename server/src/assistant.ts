import { formatTs, nowLocal, readonlyDb } from './db.js';
import { chat, chatJSON, type Message } from './llm.js';
import { PRESETS } from './presets.js';
import { runReadOnly, UnsafeSqlError, type QueryResult } from './sqlGuard.js';

export interface ChartSpec {
  type: 'line' | 'bar' | 'none';
  x?: string;
  y?: string[];
  groupBy?: string;
}

export interface HistoryItem {
  question: string;
  sql: string;
}

export interface AskResult extends QueryResult {
  question: string;
  sql: string;
  chart: ChartSpec;
  answer: string | null;
  explanation: string;
  attempts: number;
  source: 'ai' | 'preset';
}

export const THRESHOLDS = `Reference thresholds:
- PM2.5 (µg/m³): good ≤ 15 (WHO 24h guideline), moderate 15–35, unhealthy > 35, very unhealthy > 55
- PM10 (µg/m³): WHO 24h guideline 45
- CO2 (ppm): good < 800, fair 800–1000, poor ventilation > 1000, very poor > 1500
- TVOC (ppb): good < 220, moderate 220–660, high > 660
- Temperature (°C): comfortable 21–26. Server rooms: 18–27
- Humidity (%RH): comfortable 40–60`;

function dataRange(): { from: string; to: string; rows: number } {
  const r = readonlyDb().prepare('SELECT MIN(ts) AS f, MAX(ts) AS t, COUNT(*) AS n FROM readings').get() as {
    f: string;
    t: string;
    n: number;
  };
  return { from: r.f, to: r.t, rows: r.n };
}

function rooms(): string {
  const rows = readonlyDb().prepare('SELECT id, room, floor, zone FROM devices ORDER BY id').all() as {
    id: string;
    room: string;
    floor: number;
    zone: string;
  }[];
  return rows.map((r) => `  ${r.id} = '${r.room}' (floor ${r.floor}, ${r.zone})`).join('\n');
}

function sqlSystemPrompt(): string {
  const range = dataRange();
  const examples = PRESETS.slice(0, 3)
    .map((p) => `Question: ${p.question}\n${JSON.stringify({ sql: p.sql, chart: p.chart, explanation: '...' })}`)
    .join('\n\n');

  return `You are a SQLite expert who turns questions about indoor air quality into ONE read-only SQLite query.

DATABASE SCHEMA
devices(id TEXT PK, name TEXT, room TEXT, floor INTEGER, zone TEXT)
readings(id INTEGER PK, device_id TEXT -> devices.id, ts TEXT 'YYYY-MM-DD HH:MM:SS' local time,
         pm25 REAL µg/m³, pm10 REAL µg/m³, co2 INTEGER ppm, tvoc INTEGER ppb,
         temperature REAL °C, humidity REAL %RH)
One reading per device every 15 minutes.

DEVICES
${rooms()}

DATA RANGE: ${range.from} to ${range.to} (${range.rows.toLocaleString()} readings).
Current local time: ${formatTs(nowLocal())}.

${THRESHOLDS}

RULES
- SQLite dialect only. One SELECT (CTEs allowed). Never modify data.
- Treat the latest reading as "now": use datetime((SELECT MAX(ts) FROM readings), '-7 days') etc. for relative ranges
  ("today" = date(ts) = date((SELECT MAX(ts) FROM readings)); "this week" = last 7 days).
- Always JOIN devices to show room names instead of device ids.
- Match rooms with the exact names above. For fuzzy mentions ("the lab", "conference room") pick the closest room.
- Use readable snake_case aliases with units where helpful (avg_pm25, hours_above_1000).
- ROUND averages (1 decimal for pm/temperature/humidity, 0 for co2/tvoc).
- For time series, aggregate so there are at most ~200 points per series (hourly for ≤ 3 days, daily for longer).
- Each reading represents 0.25 hours when computing durations.
- Order results sensibly (time ascending for series, worst first for rankings).

CHART
Pick a chart for the result:
- "line" for values over time; "bar" for comparing rooms/categories; "none" for single values or lists.
- x = the column for the x-axis; y = numeric column(s) to plot.
- If the result has one row per (time, room), set groupBy to "room" and y to one numeric column.

Return JSON: {"sql": "...", "chart": {"type": "line"|"bar"|"none", "x": "...", "y": ["..."], "groupBy": "..."}, "explanation": "one short sentence on what the query does"}

EXAMPLES
${examples}`;
}

function normalizeChart(c: unknown, columns: string[]): ChartSpec {
  const chart = (c && typeof c === 'object' ? c : {}) as Partial<ChartSpec>;
  const type = chart.type === 'line' || chart.type === 'bar' ? chart.type : 'none';
  if (type === 'none') return { type };
  const x = typeof chart.x === 'string' && columns.includes(chart.x) ? chart.x : undefined;
  const y = Array.isArray(chart.y) ? chart.y.filter((v): v is string => typeof v === 'string' && columns.includes(v)) : [];
  const groupBy = typeof chart.groupBy === 'string' && columns.includes(chart.groupBy) ? chart.groupBy : undefined;
  if (!x || y.length === 0) return { type: 'none' };
  return { type, x, y, ...(groupBy ? { groupBy } : {}) };
}

/** Text-to-SQL with one self-correction pass if the query fails. */
export async function ask(question: string, history: HistoryItem[] = []): Promise<AskResult> {
  const messages: Message[] = [{ role: 'system', content: sqlSystemPrompt() }];
  for (const h of history.slice(-3)) {
    messages.push({ role: 'user', content: h.question });
    messages.push({ role: 'assistant', content: JSON.stringify({ sql: h.sql }) });
  }
  messages.push({ role: 'user', content: question });

  const maxAttempts = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const plan = await chatJSON<{ sql?: string; chart?: unknown; explanation?: string }>(messages, { temperature: 0 });
    const sql = typeof plan.sql === 'string' ? plan.sql.trim() : '';
    try {
      if (!sql) throw new Error('The model did not return a SQL query.');
      const result = runReadOnly(sql);
      const chart = normalizeChart(plan.chart, result.columns);
      const answer = await summarize(question, sql, result).catch(() => null);
      return {
        question,
        sql,
        chart,
        answer,
        explanation: typeof plan.explanation === 'string' ? plan.explanation : '',
        attempts: attempt,
        source: 'ai',
        ...result,
      };
    } catch (err) {
      lastError = (err as Error).message;
      if (err instanceof UnsafeSqlError && attempt === maxAttempts) break;
      messages.push({ role: 'assistant', content: JSON.stringify(plan) });
      messages.push({
        role: 'user',
        content: `That query failed with: ${lastError}\nFix it and return the corrected JSON. Remember: one read-only SQLite SELECT using only the schema above.`,
      });
    }
  }
  throw new Error(`Couldn't build a working query after ${maxAttempts} attempts. Last error: ${lastError}`);
}

/** Turns the query result into a short plain-English answer. */
export async function summarize(question: string, sql: string, result: QueryResult): Promise<string> {
  if (result.rows.length === 0) return 'No readings matched that question.';
  const sample = result.rows.slice(0, 60);
  const table = [result.columns.join(' | '), ...sample.map((r) => result.columns.map((c) => String(r[c] ?? '')).join(' | '))].join('\n');

  const text = await chat(
    [
      {
        role: 'system',
        content: `You are an air-quality analyst for a building facilities team.
Answer the user's question from the query result in 2-4 short sentences.
- Lead with the direct answer and cite the key numbers with units.
- Compare against the thresholds when relevant and say whether it's a concern.
- If useful, end with one practical recommendation (ventilation, purifier, schedule change).
- Do not mention SQL, tables or "the data provided". Don't invent numbers that aren't in the result.
${THRESHOLDS}`,
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nResult (${result.rows.length}${result.truncated ? '+' : ''} rows${result.rows.length > sample.length ? `, first ${sample.length} shown` : ''}):\n${table}`,
      },
    ],
    { temperature: 0.3, maxTokens: 300 },
  );
  return text.trim();
}

/** A preset question answered with no AI at all. */
export function runPreset(p: (typeof PRESETS)[number]): AskResult {
  const result = runReadOnly(p.sql);
  return {
    question: p.question,
    sql: p.sql,
    chart: normalizeChart(p.chart, result.columns),
    answer: null,
    explanation: 'Built-in query (no AI needed).',
    attempts: 0,
    source: 'preset',
    ...result,
  };
}
