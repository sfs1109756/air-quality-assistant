import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH ?? path.resolve(here, '../data/aq.db');

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,   -- e.g. 'aq-01'
  name        TEXT NOT NULL,      -- e.g. 'SafeAir Monitor 01'
  room        TEXT NOT NULL,      -- e.g. 'Conference Room A'
  floor       INTEGER NOT NULL,
  zone        TEXT NOT NULL       -- 'office' | 'meeting' | 'food' | 'lab' | 'public' | 'technical'
);
CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  ts          TEXT NOT NULL,      -- local time 'YYYY-MM-DD HH:MM:SS'
  pm25        REAL,               -- µg/m³
  pm10        REAL,               -- µg/m³
  co2         INTEGER,            -- ppm
  tvoc        INTEGER,            -- ppb
  temperature REAL,               -- °C
  humidity    REAL                -- %RH
);
CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
`;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/** Read-write connection, used only for seeding. */
const rw = new Database(DB_PATH);
rw.pragma('journal_mode = WAL');
rw.exec(SCHEMA_SQL);

/** Regenerates the demo data when the DB is empty or the latest reading is over a day old. */
export function ensureFreshData(force = false): void {
  const latest = rw.prepare('SELECT MAX(ts) AS ts FROM readings').get() as { ts: string | null };
  const stale = !latest.ts || Date.now() - localTsToDate(latest.ts).getTime() > 24 * 3600 * 1000;
  if (force || stale) {
    const n = seed(rw);
    console.log(`Seeded ${n.toLocaleString()} demo readings.`);
  }
}

/**
 * Separate READ-ONLY connection for AI-generated SQL.
 * Even if a bad query slipped past the validator, SQLite itself refuses writes here.
 */
let ro: Database.Database | null = null;
export function readonlyDb(): Database.Database {
  if (!ro) {
    ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  }
  return ro;
}

export function rwDb(): Database.Database {
  return rw;
}

// ---- time helpers (data is stored in local time, IST by default) ----
export const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES ?? 330);

export function nowLocal(): Date {
  // A Date whose UTC fields hold the local wall-clock time.
  return new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
}

export function formatTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function localTsToDate(ts: string): Date {
  return new Date(new Date(`${ts.replace(' ', 'T')}Z`).getTime() - TZ_OFFSET_MIN * 60_000);
}
