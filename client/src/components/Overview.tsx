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
          const levels = [r.pm25 != null && pmLevel(r.pm25), r.co2 != null && co2Level(r.co2), r.tvoc != null && tvocLevel(r.tvoc)];
          const worst: Level = levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'good';
          return (
            <div key={r.id} className={`room-card ${worst}`}>
              <div className="room-head">
                <strong>{r.room}</strong>
                {r.floor > 0 && <span className="small muted">Floor {r.floor}</span>}
              </div>
              <div className="metrics">
                {r.pm25 != null && <Metric label="PM2.5" value={r.pm25} unit="µg/m³" level={pmLevel(r.pm25)} />}
                {r.co2 != null && <Metric label="CO₂" value={r.co2} unit="ppm" level={co2Level(r.co2)} />}
                {r.tvoc != null && <Metric label="TVOC" value={r.tvoc} unit="ppb" level={tvocLevel(r.tvoc)} />}
                {r.temperature != null && <Metric label="Temp" value={r.temperature} unit="°C" />}
              </div>
              <div className="small muted">
                {[r.pm25_24h != null && `24h avg PM2.5 ${r.pm25_24h}`, r.co2_peak_24h != null && `CO₂ peak ${r.co2_peak_24h} ppm`].filter(Boolean).join(' · ')}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
