export interface ChartSpec {
  type: 'line' | 'bar' | 'none';
  x?: string;
  y?: string[];
  groupBy?: string;
}

export interface AskResult {
  question: string;
  sql: string;
  chart: ChartSpec;
  answer: string | null;
  explanation: string;
  attempts: number;
  source: 'ai' | 'preset' | 'manual';
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  ms: number;
  notice?: string;
}

export interface RoomOverview {
  id: string;
  room: string;
  floor: number;
  zone: string;
  ts: string;
  pm25: number;
  pm10: number;
  co2: number;
  tvoc: number;
  temperature: number;
  humidity: number;
  pm25_24h: number;
  co2_24h: number;
  co2_peak_24h: number;
}
