// Building blocks shared by several views.
import { app, h, newId, announce, setTitle, focusElement } from './dom.js';
import { focusView } from './state.js';
import { timeAgo, escapeRegExp } from './util.js';

// Run `fn` for a button click: disable the button while it runs and show any error in
// `errorEl` (or an alert if there's nowhere to put it). The button is always re-enabled.
export async function runAction(button, errorEl, fn) {
  if (button) button.disabled = true;
  if (errorEl) errorEl.textContent = '';
  try {
    await fn();
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
    else alert(err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

// runAction, but only once the user confirms `question` (if there is one).
export function confirmAction(question, button, errorEl, fn) {
  if (question && !confirm(question)) return;
  runAction(button, errorEl, fn);
}

// A form that runs `onSubmit` through runAction (so `submit` is disabled meanwhile and errors
// appear in `error`). `validate()` runs first and can return false to stop; `onSettled()` runs
// after `onSubmit`, whether or not it succeeded.
export function asyncForm(props, { submit, error, validate, onSubmit, onSettled }, ...children) {
  return h('form', {
    ...props,
    onsubmit: async (e) => {
      e.preventDefault();
      if (validate && !validate()) return;
      await runAction(submit, error, onSubmit);
      onSettled?.();
    },
  }, ...children);
}

// Replace `container` with a "Couldn't load" message and, unless it's a 404, a Retry button.
// A 404 (e.g. "User not found") offers a way back instead.
export function showLoadError(container, err, retry) {
  const notFound = err.status === 404;
  const message = h('p', { class: 'flush' }, notFound ? err.message : `Couldn't load: ${err.message}`);
  container.replaceChildren(h('div', { class: 'card empty', role: 'alert' },
    message,
    notFound
      ? h('p', { class: 'load-error-actions' },
          h('a', { class: 'button', href: '#/' }, 'Back to Home'), ' ',
          h('a', { class: 'button', href: '#/friends' }, 'Find people'))
      : h('button', { class: 'secondary load-error-actions', onclick: retry }, 'Retry'),
  ));
  if (container === app) setTitle(notFound ? err.message : "Couldn't load");
  focusView(message);
}

// Append a "Load more" button to `container`. Clicking it calls `fetchPage(cursor)`, which
// resolves to { items, nextCursor }, and appends each item rendered with `renderItem`.
export function appendLoadMore(container, cursor, fetchPage, renderItem) {
  if (!cursor) return;
  const error = h('p', { class: 'error compact', role: 'alert' });
  const button = h('button', {
    class: 'secondary',
    onclick: () => runAction(button, error, async () => {
      const page = await fetchPage(cursor);
      if (!more.isConnected) return; // The list was replaced (new search, navigation) meanwhile.
      const items = page.items.map(renderItem);
      more.replaceWith(...items);
      appendLoadMore(container, page.nextCursor, fetchPage, renderItem);
      announce(`${items.length} more loaded.`);
      // The button is gone, so continue from the first new item rather than losing focus.
      if (items.length) focusElement(items[0].querySelector('a[href], button') ?? items[0]);
    }),
  }, 'Load more');
  // Inside a list, the button needs to be a list item itself.
  const more = h(container.tagName === 'UL' ? 'li' : 'div', { class: 'load-more' }, button, error);
  container.append(more);
}

// When a post or comment was written: the relative time (kept fresh by the router's clock tick),
// with the full date read out to screen readers. Clicking or tapping it shows the full date on
// screen, since a title tooltip can't be opened by touch or keyboard.
export function timestamp(iso) {
  const full = new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const time = h('time', { datetime: iso, 'data-relative': '' }, timeAgo(iso));
  const spoken = h('span', { class: 'visually-hidden' }, `, ${full}`);
  return h('button', {
    type: 'button',
    class: 'link timestamp',
    title: full,
    onclick: () => {
      const showFull = time.hasAttribute('data-relative');
      time.toggleAttribute('data-relative', !showFull);
      time.textContent = showFull ? full : timeAgo(iso);
      spoken.hidden = showFull;
    },
  }, time, spoken);
}

// A character counter for `field` with limit `max`, counting the trimmed text as the server does.
// update() refreshes it and returns { length, over }. Going over the limit is spelled out in the
// counter's text (not shown by colour alone), marks the field invalid, and is announced.
export function lengthCounter(field, max) {
  const counter = h('span', { class: 'counter', id: newId('counter') });
  let wasOver = false;
  const update = () => {
    const length = field.value.trim().length;
    const excess = length - max;
    const over = excess > 0;
    counter.textContent = over
      ? `${length} / ${max} · ${excess} over the limit`
      : `${length} / ${max}`;
    counter.classList.toggle('over', over);
    if (over) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
    if (over !== wasOver) {
      wasOver = over;
      announce(over ? `Over the ${max}-character limit.` : 'Back within the character limit.');
    }
    return { length, over };
  };
  update();
  return { counter, update };
}

// Split text into plain and <mark>ed pieces for the search term. Matching with a
// case-insensitive RegExp keeps indices on the original text (lowercasing can change a
// string's length, e.g. 'İ').
export function highlight(text, term) {
  if (!term) return [text];
  return text.split(new RegExp(`(${escapeRegExp(term)})`, 'giu'))
    .map((part, i) => (i % 2 ? h('mark', {}, part) : part))
    .filter((part) => part !== '');
}

export const profileHref = (username) => `#/u/${encodeURIComponent(username)}`;

export const userLink = (username, label = username, cls = null) =>
  h('a', { href: profileHref(username), class: cls }, label);

// The heading line of a post or comment: "@author", when it was written, and any `extra` (buttons).
export const authorLine = (username, createdAt, ...extra) => h('div', { class: 'meta-head' },
  userLink(username, `@${username}`, 'author'),
  timestamp(createdAt),
  ...extra);

// A row in a list of people: their name and `actions` (buttons).
export const userRow = (username, actions) => h('li', { class: 'user-row', 'data-username': username },
  userLink(username),
  h('div', { class: 'actions' }, actions));

// A search box inside a role="search" form, with a label only screen readers see.
export function searchForm(input, label, onSubmit) {
  input.id = newId('search');
  return h('form', {
    role: 'search',
    class: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      onSubmit();
    },
  }, h('label', { for: input.id, class: 'visually-hidden' }, label), input);
}

// Short privacy and retention notice, shown on the sign-up form and the Account page.
export function privacyNotice() {
  return h('div', { class: 'privacy-notice muted' },
    h('p', {}, 'Chirp stores your username, a hash of your password, when you joined, and what you post, '
      + 'like and comment. No email, no tracking, no third parties.'),
    h('p', {}, 'Posts are seen only by you and your friends. A comment is seen by the post’s author '
      + 'and by your own friends who can see that post.'),
    h('p', {}, 'Everything is kept until you delete it or your account. Deleting your account erases it all; '
      + 'you can download a copy of your data first.'),
  );
}
