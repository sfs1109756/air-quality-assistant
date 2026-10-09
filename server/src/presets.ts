import type { ChartSpec } from './assistant.js';

/**
 * Hand-written questions that run without any AI.
 * "Now" is anchored to the latest reading so the queries work on any dataset.
 */
export interface Preset {
  id: string;
  question: string;
  sql: string;
  chart: ChartSpec;
}

const LATEST = '(SELECT MAX(ts) FROM readings)';

export const PRESETS: Preset[] = [
  {
    id: 'worst-pm25-week',
    question: 'Which room had the worst PM2.5 this week?',
    sql: `SELECT d.room AS room,
       ROUND(AVG(r.pm25), 1) AS avg_pm25,
       ROUND(MAX(r.pm25), 1) AS peak_pm25
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE r.ts >= datetime(${LATEST}, '-7 days')
GROUP BY d.room
ORDER BY avg_pm25 DESC`,
    chart: { type: 'bar', x: 'room', y: ['avg_pm25', 'peak_pm25'] },
  },
  {
    id: 'co2-by-hour',
    question: 'How does CO2 change through a weekday in each room?',
    sql: `SELECT CAST(strftime('%H', r.ts) AS INTEGER) AS hour,
       d.room AS room,
       ROUND(AVG(r.co2)) AS avg_co2
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE r.ts >= datetime(${LATEST}, '-14 days')
  AND strftime('%w', r.ts) BETWEEN '1' AND '5'
GROUP BY hour, room
ORDER BY hour`,
    chart: { type: 'line', x: 'hour', y: ['avg_co2'], groupBy: 'room' },
  },
  {
    id: 'daily-pm25',
    question: 'Daily average PM2.5 per room for the last 14 days',
    sql: `SELECT date(r.ts) AS day,
       d.room AS room,
       ROUND(AVG(r.pm25), 1) AS avg_pm25
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE r.ts >= datetime(${LATEST}, '-14 days')
GROUP BY day, room
ORDER BY day`,
    chart: { type: 'line', x: 'day', y: ['avg_pm25'], groupBy: 'room' },
  },
  {
    id: 'co2-over-1000',
    question: 'How many hours did each room spend above 1000 ppm CO2 this week?',
    sql: `SELECT d.room AS room,
       ROUND(SUM(CASE WHEN r.co2 > 1000 THEN 0.25 ELSE 0 END), 1) AS hours_above_1000
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE r.ts >= datetime(${LATEST}, '-7 days')
GROUP BY d.room
ORDER BY hours_above_1000 DESC`,
    chart: { type: 'bar', x: 'room', y: ['hours_above_1000'] },
  },
  {
    id: 'conf-co2-24h',
    question: 'Show CO2 in Conference Room A over the last 24 hours',
    sql: `SELECT strftime('%Y-%m-%d %H:%M', r.ts) AS time, r.co2 AS co2
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE d.room = 'Conference Room A'
  AND r.ts >= datetime(${LATEST}, '-1 day')
ORDER BY r.ts`,
    chart: { type: 'line', x: 'time', y: ['co2'] },
  },
  {
    id: 'lab-tvoc-spikes',
    question: 'How many TVOC spikes above 500 ppb did the R&D Lab have each day?',
    sql: `SELECT date(r.ts) AS day,
       SUM(CASE WHEN r.tvoc > 500 THEN 1 ELSE 0 END) AS spike_readings,
       MAX(r.tvoc) AS peak_tvoc
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE d.room = 'R&D Lab' AND r.ts >= datetime(${LATEST}, '-14 days')
GROUP BY day
ORDER BY day`,
    chart: { type: 'bar', x: 'day', y: ['spike_readings'] },
  },
  {
    id: 'server-room-climate',
    question: 'Server room temperature and humidity over the last 3 days',
    sql: `SELECT strftime('%Y-%m-%d %H:00', r.ts) AS hour,
       ROUND(AVG(r.temperature), 1) AS temperature,
       ROUND(AVG(r.humidity), 1) AS humidity
FROM readings r JOIN devices d ON d.id = r.device_id
WHERE d.room = 'Server Room' AND r.ts >= datetime(${LATEST}, '-3 days')
GROUP BY hour
ORDER BY hour`,
    chart: { type: 'line', x: 'hour', y: ['temperature', 'humidity'] },
  },
];

export function findPreset(idOrQuestion: string): Preset | undefined {
  const q = idOrQuestion.trim().toLowerCase();
  return PRESETS.find((p) => p.id === q || p.question.toLowerCase() === q);
}
