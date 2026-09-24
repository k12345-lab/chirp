// State shared by the views: who is logged in, which view is current, and whether the next view
// should take keyboard focus. The current user is only changed through setMe(), which tells
// every onMeChange listener (the router uses it to redraw the nav).
import { api } from './api.js';
import { focusElement } from './dom.js';

let me = null; // { username, pendingRequests }
const meListeners = [];
let viewToken = 0; // Bumped whenever a view starts rendering; see startView().
let focusPending = false; // Set on route changes, so the next view moves focus to its heading.
let renderRoute = () => {}; // The router's render(); see setRenderer().

// ---------- Current user ----------

export const getMe = () => me;

export function setMe(user) {
  me = user;
  for (const listener of meListeners) listener(me);
}

export function onMeChange(listener) {
  meListeners.push(listener);
}

// Load the current user. Only a 401 means "logged out"; other failures (e.g. offline)
// are thrown so the caller can show an error instead of the login form.
export async function refreshMe() {
  try {
    setMe(await api('GET', '/api/me'));
  } catch (err) {
    if (err.status !== 401) throw err;
    setMe(null);
  }
}

// Quietly refresh the Friends badge while logged in (on navigation, on a timer, and after
// friend actions). Failures are ignored; the router handles a 401.
export async function refreshBadge() {
  if (!me) return;
  try {
    const fresh = await api('GET', '/api/me');
    if (me) setMe(fresh);
  } catch {
    // Keep the current badge.
  }
}

// ---------- Views and navigation ----------

// Start rendering a view. The returned function tells whether that view is still the current
// one, so a slow response can't overwrite a page the user has since navigated away from.
export function startView() {
  const token = ++viewToken;
  return () => token === viewToken;
}

// Ask the next view to move focus to its heading (see focusView), or cancel that request.
export function requestFocus(pending = true) {
  focusPending = pending;
}

// After a route change, move focus to the new view's heading (or error message), so keyboard
// and screen reader users start at the new content instead of wherever focus was left.
export function focusView(el) {
  if (!focusPending) return;
  focusPending = false;
  focusElement(el);
}

// The router registers its render function here, so views can navigate without importing it.
export function setRenderer(render) {
  renderRoute = render;
}

// Render the view for the current hash again.
export const rerender = () => renderRoute();

// Go to `hash` and render once: setting a new hash renders via hashchange, so only
// render directly when we're already there.
export function navigate(hash) {
  focusPending = true;
  if ((location.hash || '#/') === hash) renderRoute();
  else location.hash = hash;
}

// After logging out (or deleting the account), show the login form.
export function loggedOut() {
  setMe(null);
  navigate('#/');
}
