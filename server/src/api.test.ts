import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

/** End-to-end API tests on a temporary database, with a fake Ollama. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

let api = '';
const servers: http.Server[] = [];
const listen = (s: http.Server) =>
  new Promise<string>((r) => s.listen(0, () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

const fakeOllama = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const system: string = body.messages?.[0]?.content ?? '';
    if (body.stream) {
      for (const w of ['Cafeteria ', 'was ', 'worst.']) res.write(`${JSON.stringify({ message: { content: w } })}\n`);
      return void res.end(`${JSON.stringify({ done: true })}\n`);
    }
    // First attempt returns broken SQL to exercise self-correction.
    const fixed = body.messages.some((m: { content: string }) => m.content.includes('That query failed'));
    const sql = fixed
      ? 'SELECT d.room AS room, ROUND(AVG(r.pm25), 1) AS avg_pm25 FROM readings r JOIN devices d ON d.id = r.device_id GROUP BY d.room ORDER BY avg_pm25 DESC'
      : 'SELECT nope FROM readings';
    assert.ok(system.includes('SQLite expert'));
    res.end(JSON.stringify({ message: { content: JSON.stringify({ sql, chart: { type: 'bar', x: 'room', y: ['avg_pm25'] } }) } }));
  });
});

before(async () => {
  process.env.OLLAMA_URL = await listen(fakeOllama);
  process.env.LLM_PROVIDER = 'ollama';
  const { default: app } = await import('./app.js');
  const server = http.createServer(app);
  api = await listen(server);
  servers.push(fakeOllama, server);
});
after(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('seeds demo data and serves the overview', async () => {
  const src = await (await fetch(`${api}/api/data-source`)).json();
  assert.equal(src.source.kind, 'demo');
  assert.ok(src.readings > 10_000);
  const { rooms } = await (await fetch(`${api}/api/overview`)).json();
  assert.equal(rooms.length, 6);
});

test('ask self-corrects bad SQL and returns a chart spec', async () => {
  const data = await (await post('/api/ask', { question: 'Which room is worst?' })).json();
  assert.equal(data.attempts, 2);
  assert.equal(data.rows[0].room, 'Cafeteria');
  assert.deepEqual(data.chart, { type: 'bar', x: 'room', y: ['avg_pm25'] });
});

test('summaries stream', async () => {
  const res = await post('/api/summarize', { question: 'q', columns: ['room'], rows: [{ room: 'Cafeteria' }] });
  const events = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(events.at(-1).text, 'Cafeteria was worst.');
});

test('presets work with AI turned off', async () => {
  process.env.LLM_PROVIDER = 'none';
  const res = await post('/api/presets/worst-pm25-week', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rows.length, 6);
  const ask = await post('/api/ask', { question: 'Which room had the worst PM2.5 this week?' });
  assert.equal((await ask.json()).source, 'preset');
  process.env.LLM_PROVIDER = 'ollama';
});

test('edited SQL is read-only', async () => {
  assert.equal((await post('/api/sql', { sql: 'DELETE FROM readings' })).status, 400);
  assert.equal((await post('/api/sql', { sql: 'SELECT COUNT(*) AS n FROM devices' })).status, 200);
});

test('insights find the demo problems', async () => {
  const { insights } = await (await fetch(`${api}/api/insights`)).json();
  const titles = insights.map((i: { title: string }) => i.title).join('\n');
  assert.match(titles, /poor ventilation/);
  assert.match(titles, /PM2\.5 above the WHO guideline/);
});

test('CSV import replaces the data and survives restart checks', async () => {
  const csv = [
    'Time;Location;Sensor ID;PM2.5 (µg/m³);CO2 ppm;Temp',
    ...Array.from(
      { length: 48 },
      (_, i) =>
        `09/10/2026 ${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'};Lab 2;esp-7;${(10 + i / 4).toFixed(1).replace('.', ',')};${600 + i * 10};24`,
    ),
    'not a date;Lab 2;esp-7;1;1;1',
  ].join('\n');
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'export.csv');
  const res = await fetch(`${api}/api/import`, { method: 'POST', body: form });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.imported, 48);
  assert.equal(out.skipped, 1);
  assert.equal(out.devices, 1);
  assert.equal(out.from, '2026-10-09 00:00:00');
  assert.equal(out.mapped.pm25, 'PM2.5 (µg/m³)');

  const src = await (await fetch(`${api}/api/data-source`)).json();
  assert.equal(src.source.kind, 'import');
  const { ensureFreshData } = await import('./db.js');
  ensureFreshData(); // imported data must not be replaced by demo data
  const { rows } = await (
    await post('/api/sql', {
      sql: 'SELECT room, MAX(co2) AS peak FROM readings JOIN devices ON devices.id = readings.device_id GROUP BY room',
    })
  ).json();
  assert.deepEqual(rows, [{ room: 'Lab 2', peak: 1070 }]);
});

test('CSV import explains what is missing', async () => {
  const form = new FormData();
  form.append('file', new Blob(['a,b\n1,2'], { type: 'text/csv' }), 'bad.csv');
  const res = await fetch(`${api}/api/import`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /timestamp column/);
});
