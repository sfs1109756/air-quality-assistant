import app from './app.js';

const port = Number(process.env.PORT ?? 3002);
app.listen(port, () => console.log(`Air Quality Assistant API on http://localhost:${port}`));
