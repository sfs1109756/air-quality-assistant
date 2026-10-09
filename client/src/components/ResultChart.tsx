import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartSpec } from '../types';

const PALETTE = ['#2f6fed', '#e5484d', '#12a594', '#f5a524', '#8e4ec6', '#ec5d95', '#3e9b4f', '#7c66dc'];

/**
 * Turns long-format rows (time, room, value) into wide format (time, Room A, Room B…)
 * so each room becomes its own line/bar series.
 */
function pivot(rows: Record<string, unknown>[], x: string, groupBy: string, y: string) {
  const series = new Set<string>();
  const byX = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = String(r[x]);
    const group = String(r[groupBy]);
    series.add(group);
    const row = byX.get(key) ?? { [x]: r[x] };
    row[group] = r[y];
    byX.set(key, row);
  }
  return { data: [...byX.values()], keys: [...series] };
}

const WORDS: Record<string, string> = { pm25: 'PM2.5', pm10: 'PM10', co2: 'CO₂', tvoc: 'TVOC', avg: 'Avg', max: 'Max', min: 'Min' };

/** 'avg_pm25' → 'Avg PM2.5', 'hours_above_1000' → 'Hours above 1000'. */
export function prettyLabel(key: string): string {
  const words = key.split('_').map((w) => WORDS[w.toLowerCase()] ?? w);
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortTick(v: unknown): string {
  const s = String(v);
  // '2026-10-09 13:00' → '10-09 13:00'; '2026-10-09' → '10-09'
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(5, 16) : s.length > 14 ? `${s.slice(0, 13)}…` : s;
}

export function ResultChart({ spec, rows }: { spec: ChartSpec; rows: Record<string, unknown>[] }) {
  if (spec.type === 'none' || !spec.x || !spec.y?.length || rows.length === 0) return null;

  const { data, keys } = spec.groupBy ? pivot(rows, spec.x, spec.groupBy, spec.y[0]) : { data: rows, keys: spec.y };

  const common = {
    data,
    margin: { top: 8, right: 16, left: 0, bottom: 8 },
  };
  // Recharts finds its children by type, so axes are rendered inline (not in a fragment).
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />;
  const xAxis = <XAxis dataKey={spec.x} tickFormatter={shortTick} tick={{ fontSize: 12, fill: 'var(--muted)' }} minTickGap={16} />;
  const yAxis = <YAxis tick={{ fontSize: 12, fill: 'var(--muted)' }} width={48} />;
  const tooltip = (
    <Tooltip
      contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
      labelStyle={{ color: 'var(--text)' }}
    />
  );
  const legend = keys.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null;

  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={300}>
        {spec.type === 'bar' ? (
          <BarChart {...common}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            {keys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                name={spec.groupBy ? k : prettyLabel(k)}
                fill={PALETTE[i % PALETTE.length]}
                radius={[4, 4, 0, 0]}
                animationDuration={350}
              />
            ))}
          </BarChart>
        ) : (
          <LineChart {...common}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            {keys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                name={spec.groupBy ? k : prettyLabel(k)}
                animationDuration={350}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot={data.length < 40}
                connectNulls
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
