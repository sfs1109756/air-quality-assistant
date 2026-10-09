import { formatTs, rwDb, setDataSource, TZ_OFFSET_MIN } from './db.js';

/**
 * Imports your own sensor readings from CSV (e.g. exported from an ESP32 backend).
 *
 * Header names are matched loosely, so exports from most tools work as-is:
 *   time:    timestamp, ts, time, datetime, date, created_at
 *   device:  device_id, device, sensor, sensor_id, serial   (and/or)
 *   room:    room, location, zone, area, site
 *   metrics: pm25 / pm2.5 / pm2_5, pm10, co2, tvoc / voc, temperature / temp, humidity / rh
 * Timestamps: ISO 8601 (with or without offset), "YYYY-MM-DD HH:MM[:SS]",
 * "DD/MM/YYYY HH:MM[:SS]", or Unix seconds / milliseconds.
 */

const METRICS = ['pm25', 'pm10', 'co2', 'tvoc', 'temperature', 'humidity'] as const;
type MetricCol = (typeof METRICS)[number];

const ALIASES: Record<string, string[]> = {
  ts: ['timestamp', 'ts', 'time', 'datetime', 'date_time', 'date', 'created_at', 'recorded_at', 'reading_time'],
  device: ['device_id', 'device', 'deviceid', 'sensor', 'sensor_id', 'serial', 'serial_no', 'mac'],
  room: ['room', 'location', 'zone', 'area', 'site', 'place', 'room_name'],
  pm25: ['pm25', 'pm2_5', 'pm2.5', 'pm_2_5', 'pm2.5_ug_m3', 'pm25_ugm3'],
  pm10: ['pm10', 'pm_10', 'pm10_ug_m3'],
  co2: ['co2', 'co2_ppm', 'carbon_dioxide', 'eco2'],
  tvoc: ['tvoc', 'voc', 'tvoc_ppb', 'voc_ppb'],
  temperature: ['temperature', 'temp', 'temp_c', 'temperature_c', 't'],
  humidity: ['humidity', 'rh', 'hum', 'humidity_pct', 'relative_humidity'],
};

export const CSV_TEMPLATE = `timestamp,room,device_id,pm25,pm10,co2,tvoc,temperature,humidity
2026-10-01 09:00,Conference Room A,aq-01,12.4,18.1,780,190,24.1,52
2026-10-01 09:15,Conference Room A,aq-01,13.0,19.0,910,205,24.3,53
2026-10-01 09:00,Open Office,aq-02,18.2,26.0,640,170,23.8,50
`;

/** RFC 4180-ish CSV parser: quoted fields, escaped quotes, commas/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  // Auto-detect ; or tab separated files (common from Excel in many locales).
  const firstLine = src.slice(0, src.indexOf('\n') >= 0 ? src.indexOf('\n') : undefined);
  const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[µ]/g, 'u')
    .replace(/[()[\]/%³]/g, '')
    .replace(/[\s-]+/g, '_');

export function mapHeaders(headers: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = norm(h);
    for (const [target, aliases] of Object.entries(ALIASES)) {
      if (out[target] === undefined && aliases.some((a) => key === a || key.startsWith(`${a}_`))) {
        out[target] = i;
        break;
      }
    }
  });
  return out;
}

/** Parses many timestamp formats into local wall-clock time 'YYYY-MM-DD HH:MM:SS'. */
export function parseTimestamp(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{10}(\.\d+)?$/.test(s) || /^\d{13}$/.test(s)) {
    const ms = s.length === 13 ? Number(s) : Number(s) * 1000;
    return formatTs(new Date(ms + TZ_OFFSET_MIN * 60_000));
  }
  // ISO with an explicit zone → convert to local time.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : formatTs(new Date(d.getTime() + TZ_OFFSET_MIN * 60_000));
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return build(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) {
    let hour = +(m[4] ?? 0);
    if (m[7]) hour = (hour % 12) + (m[7].toLowerCase() === 'pm' ? 12 : 0);
    return build(+m[3], +m[2], +m[1], hour, +(m[5] ?? 0), +(m[6] ?? 0)); // day-first (India / UK)
  }
  return null;
}

function build(y: number, mo: number, d: number, h: number, mi: number, se: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (date.getUTCDate() !== d) return null; // e.g. 31/02
  return formatTs(date);
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim().replace(',', '.');
  if (!s || /^(na|n\/a|null|nan|-)$/i.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  devices: number;
  from: string | null;
  to: string | null;
  mapped: Record<string, string>;
  warnings: string[];
}

export function importCsv(text: string, fileName = 'upload.csv'): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one data row.');
  const headers = rows[0];
  const cols = mapHeaders(headers);
  if (cols.ts === undefined) throw new Error('Could not find a timestamp column (e.g. "timestamp", "time", "datetime").');
  if (cols.device === undefined && cols.room === undefined)
    throw new Error('Could not find a room or device column (e.g. "room", "location", "device_id").');
  const metricCols = METRICS.filter((m) => cols[m] !== undefined);
  if (metricCols.length === 0) throw new Error('No sensor columns found. Expected some of: pm25, pm10, co2, tvoc, temperature, humidity.');

  const warnings: string[] = [];
  const reasons = new Map<string, number>();
  const skip = (why: string) => reasons.set(why, (reasons.get(why) ?? 0) + 1);

  type Row = { device: string; room: string; ts: string } & Record<MetricCol, number | null>;
  const parsed: Row[] = [];
  for (const r of rows.slice(1)) {
    const ts = parseTimestamp(r[cols.ts] ?? '');
    if (!ts) {
      skip('unreadable timestamp');
      continue;
    }
    const room = (cols.room !== undefined ? r[cols.room] : '')?.trim() || '';
    const device = (cols.device !== undefined ? r[cols.device] : '')?.trim() || '';
    if (!room && !device) {
      skip('no room or device');
      continue;
    }
    const values = Object.fromEntries(METRICS.map((m) => [m, cols[m] !== undefined ? num(r[cols[m]]) : null])) as Record<
      MetricCol,
      number | null
    >;
    if (metricCols.every((m) => values[m] === null)) {
      skip('no sensor values');
      continue;
    }
    // Basic sanity limits so a single garbage cell doesn't wreck averages.
    if (values.co2 !== null && (values.co2 < 250 || values.co2 > 10_000)) values.co2 = null;
    if (values.pm25 !== null && (values.pm25 < 0 || values.pm25 > 2000)) values.pm25 = null;
    if (values.humidity !== null && (values.humidity < 0 || values.humidity > 100)) values.humidity = null;
    parsed.push({ ts, room: room || device, device: device || slug(room), ...values });
  }
  if (parsed.length === 0) throw new Error(`No usable rows. ${[...reasons].map(([k, v]) => `${v} × ${k}`).join(', ')}`);

  // One device per (device id, room) pair; ids stay unique if a device moved rooms.
  const devices = new Map<string, { id: string; room: string }>();
  const usedIds = new Set<string>();
  for (const p of parsed) {
    const key = `${p.device}|${p.room}`;
    if (devices.has(key)) continue;
    let id = p.device;
    for (let n = 2; usedIds.has(id); n++) id = `${p.device}-${n}`;
    usedIds.add(id);
    devices.set(key, { id, room: p.room });
  }

  const db = rwDb();
  const insDevice = db.prepare('INSERT INTO devices (id, name, room, floor, zone) VALUES (?, ?, ?, ?, ?)');
  const insReading = db.prepare(
    'INSERT INTO readings (device_id, ts, pm25, pm10, co2, tvoc, temperature, humidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    db.exec('DELETE FROM readings; DELETE FROM devices;');
    for (const d of devices.values()) insDevice.run(d.id, d.id, d.room, 0, 'imported');
    for (const p of parsed) {
      const d = devices.get(`${p.device}|${p.room}`)!;
      insReading.run(d.id, p.ts, p.pm25, p.pm10, p.co2, p.tvoc, p.temperature, p.humidity);
    }
  })();
  setDataSource({ kind: 'import', file: fileName, at: new Date().toISOString() });

  const skipped = [...reasons.values()].reduce((a, b) => a + b, 0);
  if (skipped) warnings.push(`Skipped ${skipped} rows: ${[...reasons].map(([k, v]) => `${v} × ${k}`).join(', ')}.`);
  const missing = METRICS.filter((m) => cols[m] === undefined);
  if (missing.length) warnings.push(`No column for ${missing.join(', ')} — questions about those will return empty results.`);

  const range = db.prepare('SELECT MIN(ts) AS f, MAX(ts) AS t FROM readings').get() as { f: string; t: string };
  return {
    imported: parsed.length,
    skipped,
    devices: devices.size,
    from: range.f,
    to: range.t,
    mapped: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, headers[i]])),
    warnings,
  };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'device'
  );
}
