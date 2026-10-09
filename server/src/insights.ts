import { localTsToDate, readonlyDb } from './db.js';

/**
 * Rule-based insights over the last 7 days — no AI needed.
 *  - ventilation: hours with CO2 above 1000 ppm, and the hour of day it peaks
 *  - particles: days where average PM2.5 exceeded the WHO 24h guideline
 *  - anomalies: readings far outside that room's normal level for that hour of day (z-score)
 *  - sensor health: devices that stopped reporting, gaps in data, stuck values
 * Each insight carries a follow-up question the user can send to the AI assistant.
 */

export type Severity = 'critical' | 'warning' | 'info' | 'good';
export interface Insight {
  id: string;
  severity: Severity;
  category: 'ventilation' | 'particles' | 'voc' | 'anomaly' | 'sensor';
  room: string;
  title: string;
  detail: string;
  question?: string;
}

interface Reading {
  device_id: string;
  room: string;
  ts: string;
  pm25: number | null;
  co2: number | null;
  tvoc: number | null;
}

const LATEST = '(SELECT MAX(ts) FROM readings)';
const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');

export function computeInsights(): { from: string | null; to: string | null; insights: Insight[] } {
  const db = readonlyDb();
  const range = db.prepare(`SELECT datetime(${LATEST}, '-7 days') AS f, ${LATEST} AS t`).get() as { f: string | null; t: string | null };
  if (!range.t) return { from: null, to: null, insights: [] };
  const insights: Insight[] = [];

  // ---- Ventilation (CO2) ----
  const co2Rows = db
    .prepare(
      `SELECT d.room AS room,
              COUNT(DISTINCT CASE WHEN r.co2 > 1000 THEN strftime('%Y-%m-%d %H', r.ts) END) AS hours_over,
              MAX(r.co2) AS peak
       FROM readings r JOIN devices d ON d.id = r.device_id
       WHERE r.ts >= datetime(${LATEST}, '-7 days') AND r.co2 IS NOT NULL
       GROUP BY d.room ORDER BY hours_over DESC`,
    )
    .all() as { room: string; hours_over: number; peak: number }[];
  for (const r of co2Rows) {
    if (r.hours_over < 3) continue;
    const peakHour = db
      .prepare(
        `SELECT CAST(strftime('%H', r.ts) AS INTEGER) AS hour, AVG(r.co2) AS avg
         FROM readings r JOIN devices d ON d.id = r.device_id
         WHERE d.room = ? AND r.ts >= datetime(${LATEST}, '-7 days')
         GROUP BY hour ORDER BY avg DESC LIMIT 1`,
      )
      .get(r.room) as { hour: number; avg: number } | undefined;
    insights.push({
      id: `co2-${r.room}`,
      severity: r.hours_over >= 15 || r.peak >= 1500 ? 'critical' : 'warning',
      category: 'ventilation',
      room: r.room,
      title: `${r.room}: poor ventilation in ${r.hours_over} hours this week`,
      detail: `CO₂ went above 1,000 ppm during ${r.hours_over} different hours (peak ${fmt(r.peak)} ppm)${
        peakHour ? `, and is usually worst around ${String(peakHour.hour).padStart(2, '0')}:00 (avg ${fmt(peakHour.avg)} ppm)` : ''
      }. More fresh air during busy hours would help.`,
      question: `When was CO2 above 1000 ppm in ${r.room} this week, by day and hour?`,
    });
  }

  // ---- Particles (PM2.5 daily average vs WHO 15 µg/m³) ----
  const pmRows = db
    .prepare(
      `WITH daily AS (
         SELECT d.room AS room, date(r.ts) AS day, AVG(r.pm25) AS avg
         FROM readings r JOIN devices d ON d.id = r.device_id
         WHERE date(r.ts) > date(${LATEST}, '-7 days') AND r.pm25 IS NOT NULL
         GROUP BY d.room, day
       )
       SELECT room, SUM(avg > 15) AS bad_days, COUNT(*) AS days, MAX(avg) AS worst FROM daily GROUP BY room ORDER BY bad_days DESC, worst DESC`,
    )
    .all() as { room: string; bad_days: number; days: number; worst: number }[];
  // Rooms over the guideline every day have an indoor source; occasional bad days across
  // many rooms at once usually means outdoor pollution getting in, so group those.
  const chronic = pmRows.filter((r) => r.bad_days > 0 && r.bad_days >= r.days - 1);
  const occasional = pmRows.filter((r) => r.bad_days > 0 && r.bad_days < r.days - 1);
  for (const r of chronic) {
    insights.push({
      id: `pm-${r.room}`,
      severity: r.worst > 35 ? 'critical' : 'warning',
      category: 'particles',
      room: r.room,
      title: `${r.room}: PM2.5 above the WHO guideline on ${r.bad_days} of ${r.days} days`,
      detail: `Daily average PM2.5 exceeded 15 µg/m³ almost every day (worst day ${r.worst.toFixed(1)} µg/m³), which points to an indoor source. An air purifier or better extraction would help.`,
      question: `Which hours of the day is PM2.5 worst in ${r.room}?`,
    });
  }
  if (occasional.length >= 3) {
    const worst = Math.max(...occasional.map((r) => r.worst));
    insights.push({
      id: 'pm-building',
      severity: worst > 35 ? 'warning' : 'info',
      category: 'particles',
      room: 'Several rooms',
      title: `PM2.5 above the WHO guideline in ${occasional.length} rooms on some days`,
      detail: `${occasional.map((r) => r.room).join(', ')} each had ${Math.min(...occasional.map((r) => r.bad_days))}–${Math.max(
        ...occasional.map((r) => r.bad_days),
      )} days over 15 µg/m³ (worst ${worst.toFixed(1)}). When many rooms rise together, outdoor pollution is the likely cause — keep windows closed and filters fresh on those days.`,
      question: 'Show daily average PM2.5 per room for the last 7 days',
    });
  } else {
    for (const r of occasional) {
      insights.push({
        id: `pm-${r.room}`,
        severity: 'info',
        category: 'particles',
        room: r.room,
        title: `${r.room}: PM2.5 above the WHO guideline on ${r.bad_days} of ${r.days} days`,
        detail: `Daily average PM2.5 exceeded 15 µg/m³ on ${r.bad_days} days (worst day ${r.worst.toFixed(1)} µg/m³).`,
        question: `Show daily average PM2.5 in ${r.room} for the last 7 days`,
      });
    }
  }

  // ---- Load recent readings once for anomaly + sensor checks ----
  const rows = db
    .prepare(
      `SELECT r.device_id, d.room, r.ts, r.pm25, r.co2, r.tvoc
       FROM readings r JOIN devices d ON d.id = r.device_id
       WHERE r.ts >= datetime(${LATEST}, '-30 days')
       ORDER BY r.device_id, r.ts`,
    )
    .all() as Reading[];

  insights.push(...anomalies(rows, range.f!), ...sensorHealth(rows, range.t));

  if (insights.length === 0) {
    insights.push({
      id: 'all-good',
      severity: 'good',
      category: 'ventilation',
      room: 'All rooms',
      title: 'Air quality looked healthy all week',
      detail: 'No ventilation, particle, anomaly or sensor issues were found in the last 7 days.',
    });
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  insights.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { from: range.f, to: range.t, insights };
}

/**
 * Unusual spikes: compares each reading in the last 7 days with that room's typical value
 * for the same hour of day over 30 days. Consecutive outliers are merged into one event.
 */
function anomalies(rows: Reading[], since: string): Insight[] {
  const metrics = [
    { key: 'pm25' as const, label: 'PM2.5', unit: 'µg/m³', floor: 25 },
    { key: 'co2' as const, label: 'CO₂', unit: 'ppm', floor: 1000 },
    { key: 'tvoc' as const, label: 'TVOC', unit: 'ppb', floor: 660 },
  ];
  const events: (Insight & { z: number })[] = [];

  for (const m of metrics) {
    // Robust baseline per room + hour of day (median and MAD), so past spikes don't hide new ones.
    const buckets = new Map<string, number[]>();
    for (const r of rows) {
      const v = r[m.key];
      if (v === null) continue;
      const k = `${r.room}|${r.ts.slice(11, 13)}`;
      const list = buckets.get(k);
      if (list) list.push(v);
      else buckets.set(k, [v]);
    }
    const stats = new Map<string, { n: number; median: number; scale: number }>();
    for (const [k, values] of buckets) {
      values.sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
      const mad = deviations[Math.floor(deviations.length / 2)];
      stats.set(k, { n: values.length, median, scale: Math.max(1.4826 * mad, median * 0.05, 1) });
    }
    let current: { room: string; start: string; end: string; peak: number; z: number } | null = null;
    const flush = () => {
      if (!current) return;
      events.push({
        id: `anomaly-${m.key}-${current.room}-${current.start}`,
        severity: current.z >= 10 ? 'warning' : 'info',
        category: m.key === 'tvoc' ? 'voc' : 'anomaly',
        room: current.room,
        title: `Unusual ${m.label} spike in ${current.room}`,
        detail: `${m.label} reached ${m.key === 'pm25' ? current.peak.toFixed(1) : fmt(current.peak)} ${m.unit} on ${current.start.slice(0, 16)}${
          current.end !== current.start ? `–${current.end.slice(11, 16)}` : ''
        }, well above the usual ${m.key === 'pm25' ? 'level' : 'reading'} for that time of day.`,
        question: `What happened to ${m.label.replace('₂', '2')} in ${current.room} around ${current.start.slice(0, 13)}:00?`,
        z: current.z,
      });
      current = null;
    };

    for (const r of rows) {
      const v = r[m.key];
      if (v === null || r.ts < since) continue;
      const s = stats.get(`${r.room}|${r.ts.slice(11, 13)}`)!;
      const z = (v - s.median) / s.scale;
      const isOutlier = s.n >= 10 && z >= 5 && v >= m.floor;
      const gapOk = current && current.room === r.room && localTsToDate(r.ts).getTime() - localTsToDate(current.end).getTime() <= 3600_000;
      if (isOutlier) {
        if (current && gapOk) {
          current.end = r.ts;
          current.peak = Math.max(current.peak, v);
          current.z = Math.max(current.z, z);
        } else {
          flush();
          current = { room: r.room, start: r.ts, end: r.ts, peak: v, z };
        }
      } else if (current && !gapOk) flush();
    }
    flush();
  }
  return events
    .sort((a, b) => b.z - a.z)
    .slice(0, 5)
    .map(({ z: _z, ...rest }) => rest);
}

/** Devices that stopped reporting, have gaps, or repeat the same value (stuck sensor). */
function sensorHealth(rows: Reading[], latest: string): Insight[] {
  const out: Insight[] = [];
  const latestMs = localTsToDate(latest).getTime();
  const byDevice = new Map<string, Reading[]>();
  for (const r of rows) {
    const list = byDevice.get(r.device_id);
    if (list) list.push(r);
    else byDevice.set(r.device_id, [r]);
  }

  for (const [device, list] of byDevice) {
    const room = list[0].room;
    const last = list[list.length - 1];
    const silentFor = (latestMs - localTsToDate(last.ts).getTime()) / 3600_000;
    if (silentFor >= 3) {
      out.push({
        id: `silent-${device}`,
        severity: 'critical',
        category: 'sensor',
        room,
        title: `${device} in ${room} stopped reporting`,
        detail: `No readings for ${silentFor.toFixed(0)} hours (last at ${last.ts.slice(0, 16)}). Check power and Wi-Fi.`,
      });
      continue;
    }
    // Gaps over 2 hours in the last 7 days.
    let gaps = 0;
    let longest = 0;
    for (let i = 1; i < list.length; i++) {
      if (latestMs - localTsToDate(list[i].ts).getTime() > 7 * 86_400_000) continue;
      const gap = (localTsToDate(list[i].ts).getTime() - localTsToDate(list[i - 1].ts).getTime()) / 3600_000;
      if (gap > 2) {
        gaps++;
        longest = Math.max(longest, gap);
      }
    }
    if (gaps) {
      out.push({
        id: `gaps-${device}`,
        severity: 'info',
        category: 'sensor',
        room,
        title: `${device} in ${room} has ${gaps} data gap${gaps > 1 ? 's' : ''}`,
        detail: `The longest gap this week was ${longest.toFixed(1)} hours. Intermittent Wi-Fi or power is the usual cause.`,
      });
    }
    // Stuck CO2 sensor: 12+ identical consecutive non-null values.
    let run = 1;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].co2;
      const b = list[i].co2;
      run = a !== null && a === b ? run + 1 : 1;
      if (run >= 12) {
        out.push({
          id: `stuck-${device}`,
          severity: 'warning',
          category: 'sensor',
          room,
          title: `${device} in ${room} may have a stuck CO₂ sensor`,
          detail: `It reported exactly ${b} ppm ${run}+ times in a row around ${list[i].ts.slice(0, 16)}. Consider recalibrating.`,
        });
        break;
      }
    }
  }
  return out;
}
