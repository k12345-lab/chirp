import { nav, h } from '../dom.js';
import { api } from '../api.js';
import { getMe, loggedOut } from '../state.js';
import { runAction, profileHref } from '../components.js';

// The top navigation bar, shown only while logged in. Rebuilt whenever the current user changes
// (e.g. the Friends badge count) and on every route change.
export function renderNav() {
  const me = getMe();
  if (!me) {
    nav.hidden = true;
    nav.replaceChildren();
    return;
  }
  // The nav is rebuilt when the badge refreshes, so put focus back if it was in there.
  const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const route = location.hash || '#/';
  const link = (href, label, extra, cls = '') => h('a', {
    href,
    class: `nav-link${cls}${route === href ? ' active' : ''}`,
    'aria-current': route === href ? 'page' : null,
    'data-key': href,
  }, label, extra);

  const pending = me.pendingRequests;
  const badge = pending
    ? h('span', { class: 'badge' },
        h('span', { 'aria-hidden': 'true' }, pending),
        h('span', { class: 'visually-hidden' }, ` (${pending} pending ${pending === 1 ? 'request' : 'requests'})`))
    : null;

  const logout = h('button', {
    class: 'link',
    'data-key': 'logout',
    onclick: () => runAction(logout, null, async () => {
      await api('POST', '/api/logout');
      loggedOut();
    }),
  }, 'Log out');

  const profileLink = link(profileHref(me.username), `@${me.username}`, null, ' nav-user');
  profileLink.title = `@${me.username}`; // The name may be cut short on small screens.

  nav.hidden = false;
  nav.replaceChildren(h('nav', { class: 'nav-inner', 'aria-label': 'Main' },
    h('a', { href: '#/', class: 'brand', 'data-key': 'brand' }, 'Chirp'),
    link('#/', 'Home'),
    link('#/friends', 'Friends', badge),
    profileLink,
    logout,
  ));
  if (focused) nav.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
}
