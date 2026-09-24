// Hash-based routing: picks the view for location.hash, shows the login form while logged out
// (including when any request finds the session has ended), and runs the app-wide timers.
import { app, focusElement } from './dom.js';
import { onUnauthorized } from './api.js';
import { loadConfig } from './config.js';
import {
  getMe, setMe, onMeChange, refreshMe, refreshBadge, startView, requestFocus, setRenderer,
} from './state.js';
import { safeDecode, timeAgo } from './util.js';
import { showLoadError } from './components.js';
import { renderNav } from './views/nav.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderProfile } from './views/profile.js';
import { renderFriends } from './views/friends.js';
import { renderAccount } from './views/account.js';

const BADGE_POLL_MS = 60 * 1000;
const CLOCK_TICK_MS = 60 * 1000; // How often relative times like "5m" are refreshed.

// Render the view for the current hash, or the login form while logged out.
export function render() {
  renderNav();
  if (!getMe()) return renderAuth();
  const route = location.hash.slice(1) || '/';
  const profileMatch = route.match(/^\/u\/(.+)$/);
  if (profileMatch) return renderProfile(safeDecode(profileMatch[1]));
  if (route === '/friends') return renderFriends();
  if (route === '/account') return renderAccount();
  return renderHome();
}

// On startup, a failure other than 401 (e.g. offline) shows Retry instead of the login form.
export async function start() {
  try {
    await Promise.all([loadConfig(), refreshMe()]);
  } catch (err) {
    startView();
    showLoadError(app, err, start);
    return;
  }
  render();
}

setRenderer(render);
onMeChange(renderNav);

// A 401 while we think we're logged in means the session has ended (expired, or logged out on
// another device): show the login form, keeping the hash so the same page opens after logging in.
// While logged out (e.g. a wrong password on the login form) there's nothing to do.
onUnauthorized(() => {
  if (!getMe()) return;
  setMe(null);
  render();
});

window.addEventListener('hashchange', () => {
  requestFocus();
  render();
  refreshBadge();
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshBadge();
}, BADGE_POLL_MS);
// Keep relative times ("5m") current. Ones switched to the full date are left alone.
setInterval(() => {
  for (const time of document.querySelectorAll('time[data-relative]')) time.textContent = timeAgo(time.dateTime);
}, CLOCK_TICK_MS);

// The skip link can't be a plain #app link, because hashes are routes here.
document.querySelector('.skip-link').addEventListener('click', (e) => {
  e.preventDefault();
  focusElement(app.querySelector('h1') ?? app);
});
