import type Database from 'better-sqlite3';
import { formatTs, nowLocal } from './db.js';

/**
 * Generates 30 days of realistic indoor air-quality data at 15-minute intervals.
 * Patterns: office occupancy drives CO2, cooking drives cafeteria PM, the lab has
 * solvent (TVOC) spikes, the server room runs warm and dry, and outdoor pollution
 * leaks in more on weekday evenings and in the morning rush.
 * Deterministic (seeded PRNG) so everyone gets similar charts.
 */

export const DEVICES = [
  { id: 'aq-01', name: 'SafeAir Monitor 01', room: 'Conference Room A', floor: 2, zone: 'meeting' },
  { id: 'aq-02', name: 'SafeAir Monitor 02', room: 'Open Office', floor: 2, zone: 'office' },
  { id: 'aq-03', name: 'SafeAir Monitor 03', room: 'Cafeteria', floor: 1, zone: 'food' },
  { id: 'aq-04', name: 'SafeAir Monitor 04', room: 'R&D Lab', floor: 3, zone: 'lab' },
  { id: 'aq-05', name: 'SafeAir Monitor 05', room: 'Reception', floor: 1, zone: 'public' },
  { id: 'aq-06', name: 'SafeAir Monitor 06', room: 'Server Room', floor: 3, zone: 'technical' },
] as const;

type Zone = (typeof DEVICES)[number]['zone'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function occupancy(zone: Zone, hour: number, weekday: boolean, rand: () => number): number {
  if (!weekday) return zone === 'technical' ? 0.05 : rand() < 0.1 ? 0.15 : 0.02;
  const work = hour >= 9 && hour < 19;
  switch (zone) {
    case 'meeting':
      // Meetings come in blocks; a full room for an hour then empty.
      return work && rand() < 0.55 ? 0.6 + rand() * 0.4 : 0.05;
    case 'office':
      return work ? 0.7 + 0.2 * Math.sin(((hour - 9) / 10) * Math.PI) : hour >= 19 && hour < 21 ? 0.2 : 0.02;
    case 'food':
      return hour >= 12 && hour < 15 ? 0.9 : hour >= 8 && hour < 10 ? 0.4 : hour >= 16 && hour < 18 ? 0.35 : 0.03;
    case 'lab':
      return work ? 0.5 : 0.03;
    case 'public':
      return work ? 0.35 + rand() * 0.3 : 0.02;
    case 'technical':
      return work ? 0.08 : 0.02;
  }
}

export function seed(db: Database.Database, days = 30, stepMin = 15): number {
  const rand = mulberry32(20261009);
  const end = nowLocal();
  end.setUTCSeconds(0, 0);
  end.setUTCMinutes(Math.floor(end.getUTCMinutes() / stepMin) * stepMin);
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);

  db.exec('DELETE FROM readings; DELETE FROM devices;');
  const insDevice = db.prepare('INSERT INTO devices (id, name, room, floor, zone) VALUES (?, ?, ?, ?, ?)');
  const insReading = db.prepare(
    'INSERT INTO readings (device_id, ts, pm25, pm10, co2, tvoc, temperature, humidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const d of DEVICES) insDevice.run(d.id, d.name, d.room, d.floor, d.zone);

    // Outdoor PM2.5 baseline varies day to day (Mumbai-like: some bad days).
    const dailyOutdoor: number[] = [];
    for (let i = 0; i <= days + 1; i++) dailyOutdoor.push(25 + rand() * 45 + (rand() < 0.15 ? 40 : 0));

    for (const d of DEVICES) {
      let co2 = 450;
      let pm = 15;
      let tvoc = 120;
      let temp = d.zone === 'technical' ? 22 : 24;
      let hum = 55;
      for (let t = start.getTime(); t <= end.getTime(); t += stepMin * 60_000) {
        const now = new Date(t);
        const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
        const dow = now.getUTCDay();
        const weekday = dow >= 1 && dow <= 5;
        const dayIdx = Math.floor((t - start.getTime()) / 86_400_000);
        const occ = occupancy(d.zone, Math.floor(hour), weekday, rand);
        const hvacOn = weekday && hour >= 8 && hour < 20;

        // CO2: people add it, ventilation removes it toward ~420 ppm.
        const vent = hvacOn ? 0.18 : 0.05;
        const target = 420 + occ * (d.zone === 'meeting' ? 1500 : d.zone === 'office' ? 900 : 600);
        co2 += (target - co2) * (0.25 + vent) + (rand() - 0.5) * 40;
        co2 = clamp(co2, 400, 3000);

        // PM2.5: outdoor infiltration + cooking + resuspension from people.
        const outdoor = dailyOutdoor[dayIdx] * (hour >= 7 && hour < 10 ? 1.3 : hour >= 18 && hour < 22 ? 1.4 : 0.9);
        const indoorFromOutdoor = outdoor * (hvacOn ? 0.25 : 0.45);
        const cooking = d.zone === 'food' && ((hour >= 11.5 && hour < 14) || (hour >= 7.5 && hour < 9)) ? 25 + rand() * 45 : 0;
        const people = occ * 6;
        pm += (indoorFromOutdoor + cooking + people - pm) * 0.4 + (rand() - 0.5) * 3;
        pm = clamp(pm, 2, 250);

        // TVOC: lab solvents, cleaning in the evening, people.
        const solvent = d.zone === 'lab' && weekday && hour >= 10 && hour < 17 && rand() < 0.12 ? 1300 + rand() * 1500 : 0;
        const cleaning = hour >= 20 && hour < 21 && d.zone !== 'technical' ? 250 : 0;
        tvoc += (100 + occ * 250 + solvent + cleaning - tvoc) * 0.35 + (rand() - 0.5) * 30;
        tvoc = clamp(tvoc, 30, 3000);

        // Temperature & humidity.
        const baseT = d.zone === 'technical' ? 21.5 + (rand() < 0.01 ? 6 : 0) : hvacOn ? 23.5 : 27.5;
        temp += (baseT + occ * 1.5 - temp) * 0.3 + (rand() - 0.5) * 0.3;
        const baseH = d.zone === 'technical' ? 38 : hvacOn ? 52 : 68;
        hum += (baseH + (d.zone === 'food' ? cooking * 0.2 : 0) - hum) * 0.3 + (rand() - 0.5) * 1.5;

        // Occasional sensor dropout (realistic gaps).
        if (rand() < 0.002) continue;

        insReading.run(
          d.id,
          formatTs(now),
          Math.round(pm * 10) / 10,
          Math.round(pm * (1.3 + rand() * 0.4) * 10) / 10,
          Math.round(co2),
          Math.round(tvoc),
          Math.round(temp * 10) / 10,
          Math.round(clamp(hum, 20, 95) * 10) / 10,
        );
        count++;
      }
    }
  });
  tx();
  return count;
}
