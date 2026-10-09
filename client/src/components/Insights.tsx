import { useEffect, useState } from 'react';
import { getJSON } from '../api';

interface Insight {
  id: string;
  severity: 'critical' | 'warning' | 'info' | 'good';
  category: string;
  room: string;
  title: string;
  detail: string;
  question?: string;
}

const ICON: Record<string, string> = { ventilation: '🌬️', particles: '🌫️', voc: '🧪', anomaly: '📈', sensor: '📟' };

/** Weekly rule-based findings. "Ask" sends the suggested follow-up to the AI assistant. */
export function Insights({ refreshKey, onAsk, aiReady }: { refreshKey: number; onAsk: (q: string) => void; aiReady: boolean }) {
  const [items, setItems] = useState<Insight[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getJSON<{ insights: Insight[] }>('/api/insights')
      .then((d) => setItems(d.insights))
      .catch((e) => setError(e.message));
  }, [refreshKey]);

  if (error) return <div className="error">{error}</div>;
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, 3);

  return (
    <section className="insights">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="section-title">This week's insights</h2>
        <span className="small muted">Rule-based · no AI needed</span>
      </div>
      <div className="insight-grid">
        {shown.map((i) => (
          <div key={i.id} className={`insight ${i.severity}`}>
            <div className="insight-head">
              <span className="insight-icon">{ICON[i.category] ?? '•'}</span>
              <strong>{i.title}</strong>
            </div>
            <p className="small muted">{i.detail}</p>
            {i.question && aiReady && (
              <button className="link small" onClick={() => onAsk(i.question!)}>
                Ask: “{i.question}” →
              </button>
            )}
          </div>
        ))}
      </div>
      {items.length > 3 && (
        <button className="ghost small" onClick={() => setExpanded((v) => !v)} style={{ marginTop: 8 }}>
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
