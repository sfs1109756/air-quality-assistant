import app from './app.js';

const port = Number(process.env.PORT ?? 3002);
// Local-only by default; set HOST=0.0.0.0 to expose it on your network (the Docker image does).
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => console.log(`Air Quality Assistant API on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
