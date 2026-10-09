import { useEffect, useState } from 'react';
import { getJSON } from '../api';
import type { RoomOverview } from '../types';

type Level = 'good' | 'warn' | 'bad';

const pmLevel = (v: number): Level => (v <= 15 ? 'good' : v <= 35 ? 'warn' : 'bad');
const co2Level = (v: number): Level => (v < 800 ? 'good' : v <= 1000 ? 'warn' : 'bad');
const tvocLevel = (v: number): Level => (v < 220 ? 'good' : v <= 660 ? 'warn' : 'bad');

function Metric({ label, value, unit, level }: { label: string; value: number; unit: string; level?: Level }) {
  return (
    <div className={`metric ${level ?? ''}`}>
      <div className="m-label">{label}</div>
      <div className="m-value">
        {value}
        <span className="m-unit">{unit}</span>
      </div>
    </div>
  );
}

export function Overview({ refreshKey }: { refreshKey: number }) {
  const [rooms, setRooms] = useState<RoomOverview[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    getJSON<{ rooms: RoomOverview[] }>('/api/overview')
      .then((d) => setRooms(d.rooms))
      .catch((e) => setError(e.message));
  }, [refreshKey]);

  if (error) return <div className="error">{error}</div>;
  if (!rooms.length) return null;

  return (
    <section>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="section-title">Right now</h2>
        <span className="small muted">Latest reading {rooms[0]?.ts.slice(0, 16)}</span>
      </div>
      <div className="rooms">
        {rooms.map((r) => {
          const worst: Level = [pmLevel(r.pm25), co2Level(r.co2), tvocLevel(r.tvoc)].includes('bad')
            ? 'bad'
            : [pmLevel(r.pm25), co2Level(r.co2), tvocLevel(r.tvoc)].includes('warn')
              ? 'warn'
              : 'good';
          return (
            <div key={r.id} className={`room-card ${worst}`}>
              <div className="room-head">
                <strong>{r.room}</strong>
                <span className="small muted">Floor {r.floor}</span>
              </div>
              <div className="metrics">
                <Metric label="PM2.5" value={r.pm25} unit="µg/m³" level={pmLevel(r.pm25)} />
                <Metric label="CO₂" value={r.co2} unit="ppm" level={co2Level(r.co2)} />
                <Metric label="TVOC" value={r.tvoc} unit="ppb" level={tvocLevel(r.tvoc)} />
                <Metric label="Temp" value={r.temperature} unit="°C" />
              </div>
              <div className="small muted">
                24h avg PM2.5 {r.pm25_24h} · CO₂ peak {r.co2_peak_24h} ppm
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
