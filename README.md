# 🌬️ Air Quality Assistant

Ask questions about indoor air-quality sensor data in plain English — *"When was CO2 highest in the conference room yesterday?"* — and get a short answer, a chart, and the SQL behind it.

**Runs on a local AI model by default** (Ollama). Built-in questions, live room cards and the SQL editor work with no AI at all.

![CI](https://github.com/sfs1109756/air-quality-assistant/actions/workflows/ci.yml/badge.svg)

## Features

- **Text-to-SQL with self-correction:** the model writes SQLite for your question; if the query fails, the error goes back to the model and it fixes it (up to 3 attempts).
- **Safe by design:** generated SQL is checked (single `SELECT`/`WITH` statement, no write or admin keywords, comments and string literals handled), SQLite confirms the statement is read-only, it runs on a **read-only connection**, and results are capped.
- **Charts picked by the model:** line for time series, bar for comparisons, with automatic pivoting so each room becomes its own series.
- **Follow-up questions** keep context ("now only weekdays").
- **Plain-English answers** compared against WHO / ventilation thresholds, with a practical recommendation.
- **Transparent:** view and edit the SQL, re-run it, see the table, download CSV.
- **Works offline:** 7 built-in questions run without AI; the "Right now" room cards are plain SQL.
- **Realistic demo data:** 30 days × 6 rooms at 15-minute intervals (~17,000 readings) with occupancy-driven CO2, cafeteria cooking spikes, lab solvent TVOC events, outdoor pollution days and sensor dropouts. Regenerated automatically when stale.

## How it works

```mermaid
flowchart LR
  Q[Question] --> P[Prompt: schema, rooms,<br/>data range, thresholds,<br/>examples]
  P --> M[Local model]
  M -->|sql + chart spec| G{SQL guard}
  G -->|rejected / error| M
  G -->|ok| RO[(SQLite<br/>read-only)]
  RO --> S[Model summarises<br/>the result]
  S --> UI[Answer + chart + SQL + table]
```

"Now" is anchored to the latest reading (`datetime((SELECT MAX(ts) FROM readings), '-7 days')`), so relative questions work on any dataset, including your own.

## Quick start

**Requirements:** Node.js 20+ and [Ollama](https://ollama.com).

```bash
ollama pull qwen2.5:7b     # good at SQL and JSON; ≈4.7 GB
npm run setup
npm run dev
```

Open http://localhost:5172.

> Want stronger SQL from a local model? Try `qwen2.5-coder:7b` and set `LLM_MODEL` in `server/.env`.

### Production

```bash
npm run build && npm start       # http://localhost:3002
# or
docker compose up -d && docker compose exec ollama ollama pull qwen2.5:7b
```

## Using your own data

The schema lives in `server/src/db.ts`:

```sql
devices(id, name, room, floor, zone)
readings(id, device_id, ts 'YYYY-MM-DD HH:MM:SS' local time, pm25, pm10, co2, tvoc, temperature, humidity)
```

Point `DB_PATH` at your own SQLite file with the same tables (for example, exported from a SafeAir/ESP32 backend) and the assistant, presets and room cards work unchanged. Set `TZ_OFFSET_MINUTES` if your timestamps aren't IST.

## Switching AI provider

Set `LLM_PROVIDER` in `server/.env`: `ollama` (default), `openai` (any OpenAI-compatible endpoint), `anthropic`, or `none`. See `server/.env.example`.

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/ask` | `{ question, history? }` → SQL, rows, chart spec, answer |
| `GET` | `/api/presets` · `POST /api/presets/:id` | Built-in questions (no AI) |
| `POST` | `/api/sql` | Run edited SQL (same read-only guard) |
| `GET` | `/api/overview` | Latest reading + 24h stats per room |
| `GET` | `/api/schema` · `POST /api/reseed` | Schema text · regenerate demo data |

## Scripts

`npm run dev` · `npm run build` · `npm start` · `npm test` · `npm --prefix server run seed`

## License

MIT © Faisal
