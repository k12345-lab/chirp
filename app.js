// The Express app: security headers, static files, session and CSRF middleware, and the API
// routers. Import this only after initDb(): the routers' query modules prepare their statements
// when they're loaded.
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_CONFIG, JSON_BODY_LIMIT } from './config.js';
import { loadSession } from './auth.js';
import { sameOriginOnly } from './middleware/csrf.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import postRoutes from './routes/posts.js';
import userRoutes from './routes/users.js';
import friendRoutes from './routes/friends.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy, set TRUST_PROXY (e.g. "1" or "loopback") so req.ip, req.secure and the
  // rate limits use the real client address and protocol.
  if (process.env.TRUST_PROXY) {
    const trust = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' || trust);
  }
  app.use(helmet({
    // The frontend is one HTML file plus same-origin ES modules and style.css, with no inline
    // scripts, inline styles or third-party resources, so everything else can be refused.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    xFrameOptions: { action: 'deny' }, // Matches frame-ancestors 'none' for older browsers.
  }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Every API request: identify the user from the session cookie, then refuse cross-site writes.
  app.use('/api', loadSession, sameOriginOnly);

  // Limits and names the frontend shares with the server (no login needed).
  app.get('/api/config', (req, res) => {
    res.json(CLIENT_CONFIG);
  });
  app.use('/api', authRoutes, accountRoutes, postRoutes, userRoutes, friendRoutes);
  app.use('/api', apiNotFound);

  app.use(errorHandler);
  return app;
}
