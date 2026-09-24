// Entry point (loaded by index.html as an ES module). The app is split into:
//   dom.js         DOM builder and helpers for the page's fixed elements
//   api.js         fetch wrapper for the JSON API
//   config.js      limits and names shared with the server (GET /api/config)
//   state.js       the current user, view lifecycle and navigation
//   util.js        small non-DOM helpers
//   components.js  building blocks shared by the views
//   router.js      hash routing, 401 handling, timers
//   views/*.js     one module per screen (plus shared post and friend-action widgets)
import { start } from './router.js';

start();
