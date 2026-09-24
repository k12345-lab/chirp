// Entry point: open the database, then start the web server.
import { closeDb, initDb } from './db.js';

const PORT = process.env.PORT || 3000;

initDb();
// Loaded only now, because the query modules prepare their SQL statements (once) when they're
// imported, and that needs the open database.
const { createApp } = await import('./app.js');

const server = createApp().listen(PORT, () => {
  console.log(`Chirp running at http://localhost:${PORT}`);
});

// On Ctrl+C or a stop signal, stop accepting requests, stop the cleanup timer and close the
// database cleanly.
function shutdown() {
  server.close();
  closeDb();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
