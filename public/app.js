const MAX_POST_LENGTH = 280;
const MAX_SEARCH_LENGTH = 100; // Longer searches are refused by the server.
const MIN_USER_SEARCH_LENGTH = 3; // "Find people" needs at least this many leading characters.
// Signup rules, matching the server's checks (it has the final say).
const USERNAME_PATTERN = '[A-Za-z0-9_]{3,20}';
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const BADGE_POLL_MS = 60 * 1000;
const CLOCK_TICK_MS = 60 * 1000; // How often relative times like "5m" are refreshed.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const statusRegion = document.getElementById('status');
let me = null; // { username, pendingRequests }
let viewToken = 0; // Bumped whenever a view starts rendering; see startView().
let focusPending = false; // Set on route changes, so the next view moves focus to its heading.
let idCounter = 0;

// ---------- Helpers ----------

// Tiny DOM builder. Strings become text nodes, so user content is never parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    // Via CSSOM, since the Content-Security-Policy blocks inline style attributes.
    else if (key === 'style') el.style.cssText = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// A unique id, for linking elements (label `for`, aria-describedby, aria-controls).
const newId = (prefix) => `${prefix}-${++idCounter}`;

// Read `text` out to screen reader users via the page's polite live region.
function announce(text) {
  statusRegion.textContent = '';
  // Setting it in a later task makes screen readers announce it even if the text is unchanged.
  setTimeout(() => { statusRegion.textContent = text; }, 50);
}

function setTitle(title) {
  document.title = title ? `${title} · Chirp` : 'Chirp';
}

// Move keyboard focus to `el`, making it focusable first if it isn't normally.
function focusElement(el) {
  if (!el) return;
  if (!el.matches('a[href], button, input, textarea, select')) el.setAttribute('tabindex', '-1');
  el.focus();
}

// After a route change, move focus to the new view's heading (or error message), so keyboard
// and screen reader users start at the new content instead of wherever focus was left.
function focusView(el) {
  if (!focusPending) return;
  focusPending = false;
  focusElement(el);
}

// A loading or empty-state message. role="status" makes screen readers announce it politely.
const statusMessage = (text) => h('p', { class: 'empty', role: 'status' }, text);

// Errors thrown here carry the HTTP `status` (0 if the server couldn't be reached).
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Couldn't reach Chirp. Check your connection."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    me = null;
    render();
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Start rendering a view. The returned function tells whether that view is still the current
// one, so a slow response can't overwrite a page the user has since navigated away from.
function startView() {
  const token = ++viewToken;
  return () => token === viewToken;
}

// For repeated requests (e.g. search-as-you-type): each call returns an `isLatest` check that
// stays true only until the next call, so older responses never replace newer ones.
function latestOnly() {
  let counter = 0;
  return () => {
    const id = ++counter;
    return () => id === counter;
  };
}

// Run `fn` for a button click: disable the button while it runs and show any error in
// `errorEl` (or an alert if there's nowhere to put it). The button is always re-enabled.
async function runAction(button, errorEl, fn) {
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

// Replace `container` with a "Couldn't load" message and, unless it's a 404, a Retry button.
// A 404 (e.g. "User not found") offers a way back instead.
function showLoadError(container, err, retry) {
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
function appendLoadMore(container, cursor, fetchPage, renderItem) {
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

// Short relative time for the last week ("just now", "5m", "3h", "2d"), then the date
// (with the year only when it isn't this year).
function timeAgo(iso) {
  const date = new Date(iso);
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: thisYear ? undefined : 'numeric' });
}

// When a post or comment was written: the relative time (kept fresh by the clock tick below),
// with the full date read out to screen readers. Clicking or tapping it shows the full date on
// screen, since a title tooltip can't be opened by touch or keyboard.
function timestamp(iso) {
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

// A character counter for `field`, counting the trimmed text as the server does. update()
// refreshes it and returns { length, over }. Going over the limit is spelled out in the
// counter's text (not shown by colour alone), marks the field invalid, and is announced.
function lengthCounter(field) {
  const counter = h('span', { class: 'counter', id: newId('counter') });
  let wasOver = false;
  const update = () => {
    const length = field.value.trim().length;
    const excess = length - MAX_POST_LENGTH;
    const over = excess > 0;
    counter.textContent = over
      ? `${length} / ${MAX_POST_LENGTH} · ${excess} over the limit`
      : `${length} / ${MAX_POST_LENGTH}`;
    counter.classList.toggle('over', over);
    if (over) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
    if (over !== wasOver) {
      wasOver = over;
      announce(over ? `Over the ${MAX_POST_LENGTH}-character limit.` : 'Back within the character limit.');
    }
    return { length, over };
  };
  update();
  return { counter, update };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split text into plain and <mark>ed pieces for the search term. Matching with a
// case-insensitive RegExp keeps indices on the original text (lowercasing can change a
// string's length, e.g. 'İ').
function highlight(text, term) {
  if (!term) return [text];
  return text.split(new RegExp(`(${escapeRegExp(term)})`, 'giu'))
    .map((part, i) => (i % 2 ? h('mark', {}, part) : part))
    .filter((part) => part !== '');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const userLink = (username) => h('a', { href: `#/u/${encodeURIComponent(username)}` }, username);

// A row in a list of people: their name and `actions` (buttons).
const userRow = (username, actions) => h('li', { class: 'user-row', 'data-username': username },
  userLink(username),
  h('div', { class: 'actions' }, actions));

// A search box inside a role="search" form, with a label only screen readers see.
function searchForm(input, label, onSubmit) {
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

// Go to `hash` and render once: setting a new hash renders via hashchange, so only
// render directly when we're already there.
function navigate(hash) {
  focusPending = true;
  if ((location.hash || '#/') === hash) render();
  else location.hash = hash;
}

// ---------- Nav ----------

function renderNav() {
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
      me = null;
      navigate('#/');
    }),
  }, 'Log out');

  const profileLink = link(`#/u/${encodeURIComponent(me.username)}`, `@${me.username}`, null, ' nav-user');
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

// Load the current user. Only a 401 means "logged out"; other failures (e.g. offline)
// are thrown so the caller can show an error instead of the login form.
async function refreshMe() {
  try {
    me = await api('GET', '/api/me');
  } catch (err) {
    if (err.status !== 401) throw err;
    me = null;
  }
  renderNav();
}

// Quietly refresh the Friends badge while logged in (on navigation, on a timer, and after
// friend actions). Failures are ignored; a 401 is handled by api().
async function refreshBadge() {
  if (!me) return;
  try {
    const fresh = await api('GET', '/api/me');
    if (me) {
      me = fresh;
      renderNav();
    }
  } catch {
    // Keep the current badge.
  }
}

// ---------- Auth view ----------

// Short privacy and retention notice, shown on the sign-up form and the Account page.
function privacyNotice() {
  return h('div', { class: 'privacy-notice muted' },
    h('p', {}, 'Chirp stores your username, a hash of your password, when you joined, and what you post, '
      + 'like and comment. No email, no tracking, no third parties.'),
    h('p', {}, 'Posts are seen only by you and your friends. A comment is seen by the post’s author '
      + 'and by your own friends who can see that post.'),
    h('p', {}, 'Everything is kept until you delete it or your account. Deleting your account erases it all; '
      + 'you can download a copy of your data first.'),
  );
}

function renderAuth(mode = 'login') {
  startView();
  focusPending = false; // The username field gets focus instead.
  const isLogin = mode === 'login';
  setTitle(isLogin ? 'Log in' : 'Sign up');
  const error = h('p', { class: 'error', role: 'alert', id: newId('error') });

  const username = h('input', {
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    required: true,
    // Signup checks the rules up front; login accepts whatever an existing account has.
    ...(isLogin ? {} : { minlength: 3, maxlength: 20, pattern: USERNAME_PATTERN, title: '3–20 letters, numbers or underscores' }),
  });
  const password = h('input', {
    name: 'password',
    type: 'password',
    autocomplete: isLogin ? 'current-password' : 'new-password',
    required: true,
    ...(isLogin ? {} : { minlength: MIN_PASSWORD_LENGTH, maxlength: MAX_PASSWORD_LENGTH }),
  });

  // A labelled field with an optional hint; the hint and the form's error describe the input.
  const field = (label, input, hint, ...extra) => {
    input.id = newId('field');
    const hintEl = hint && h('p', { class: 'hint', id: newId('hint') }, hint);
    input.setAttribute('aria-describedby', [hintEl && hintEl.id, error.id].filter(Boolean).join(' '));
    // Mark the field invalid when the browser's own checks fail, until it's edited again.
    input.addEventListener('invalid', () => input.setAttribute('aria-invalid', 'true'));
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl, ...extra);
  };

  const showPassword = h('input', {
    type: 'checkbox',
    onchange: () => { password.type = showPassword.checked ? 'text' : 'password'; },
  });
  const submit = h('button', { type: 'submit' }, isLogin ? 'Log in' : 'Create account');

  // Point out the field(s) a server error is about.
  const markInvalid = (message) => {
    const fields = /^invalid username or password/i.test(message) ? [username, password]
      : /^(that )?password/i.test(message) ? [password]
        : /^(that )?username/i.test(message) ? [username]
          : [];
    for (const input of fields) input.setAttribute('aria-invalid', 'true');
    fields[0]?.focus();
  };

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      runAction(submit, error, async () => {
        try {
          await api('POST', isLogin ? '/api/login' : '/api/signup', {
            username: username.value,
            password: password.value,
          });
        } catch (err) {
          markInvalid(err.message);
          throw err;
        }
        await refreshMe();
        focusPending = true;
        render(); // Keep the current hash, so a deep link like #/friends survives logging in.
      });
    },
  },
  field('Username', username, !isLogin && '3–20 characters: letters, numbers and _'),
  field('Password', password, !isLogin && `At least ${MIN_PASSWORD_LENGTH} characters.`,
    h('label', { class: 'checkbox' }, showPassword, 'Show password')),
  submit,
  error);
  showPassword.setAttribute('aria-controls', password.id);

  app.replaceChildren(h('div', { class: 'auth' },
    h('h1', {}, 'Chirp'),
    h('div', { class: 'card' },
      h('h2', {}, isLogin ? 'Log in' : 'Sign up'),
      form,
      !isLogin && privacyNotice(),
      h('p', { class: 'switch muted' },
        isLogin ? 'New here? ' : 'Already have an account? ',
        h('button', { class: 'link', type: 'button', onclick: () => renderAuth(isLogin ? 'signup' : 'login') },
          isLogin ? 'Create an account' : 'Log in'),
      ),
    ),
  ));
  username.focus();
}

// ---------- Posts ----------

// `onDeleted(card)` is called after the post was deleted, to take its card out of the list.
function renderPost(post, { searchTerm, onDeleted }) {
  const error = h('p', { class: 'error compact', role: 'alert' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // The emoji is hidden from screen readers, which get "Like (3 likes)" plus the pressed state.
  const likeLabel = () => `Like (${plural(post.likeCount, 'like')})`;
  const likeContent = () => [h('span', { 'aria-hidden': 'true' }, post.liked ? '♥' : '♡'), ` ${post.likeCount}`];
  const likeBtn = h('button', {
    class: `link like-btn${post.liked ? ' liked' : ''}`,
    'aria-pressed': String(post.liked),
    'aria-label': likeLabel(),
    onclick: () => runAction(likeBtn, error, async () => {
      // Use the server's answer rather than flipping locally, so counts can't drift.
      const state = await api(post.liked ? 'DELETE' : 'POST', `/api/posts/${post.id}/like`);
      post.liked = state.liked;
      post.likeCount = state.likeCount;
      likeBtn.classList.toggle('liked', post.liked);
      likeBtn.setAttribute('aria-pressed', String(post.liked));
      likeBtn.setAttribute('aria-label', likeLabel());
      likeBtn.replaceChildren(...likeContent());
    }),
  }, likeContent());

  const comments = h('div', { class: 'comments', id: newId('comments'), hidden: true });
  const commentLabel = () => `Comments (${post.commentCount})`;
  const commentContent = () => [h('span', { 'aria-hidden': 'true' }, '💬'), ` ${post.commentCount}`];
  const commentBtn = h('button', {
    class: 'link',
    'aria-expanded': 'false',
    'aria-controls': comments.id,
    'aria-label': commentLabel(),
    onclick: () => {
      const opening = comments.hidden;
      comments.hidden = !opening;
      commentBtn.setAttribute('aria-expanded', String(opening));
      if (opening) {
        renderComments(comments, post, () => {
          commentBtn.setAttribute('aria-label', commentLabel());
          commentBtn.replaceChildren(...commentContent());
        });
      }
    },
  }, commentContent());

  const deleteBtn = post.mine && h('button', {
    class: 'link',
    'aria-label': 'Delete post',
    onclick: () => {
      if (!confirm('Delete this post?')) return;
      runAction(deleteBtn, error, async () => {
        await api('DELETE', `/api/posts/${post.id}`);
        onDeleted(card);
      });
    },
  }, 'Delete');

  const card = h('article', { class: 'card' },
    h('div', { class: 'post-head' },
      h('a', { class: 'author', href: `#/u/${encodeURIComponent(post.username)}` }, `@${post.username}`),
      timestamp(post.createdAt),
    ),
    h('p', { class: 'post-body' }, highlight(post.body, searchTerm)),
    h('div', { class: 'post-actions' }, likeBtn, commentBtn, deleteBtn),
    error,
    comments,
  );
  return card;
}

// Load and show the comment thread for `post` inside `container`, with a reply box.
// `onCountChange` is called whenever post.commentCount changes.
async function renderComments(container, post, onCountChange) {
  container.replaceChildren(h('p', { class: 'muted comment-status', role: 'status' }, 'Loading comments…'));
  let list;
  try {
    list = await api('GET', `/api/posts/${post.id}/comments`);
  } catch (err) {
    container.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
    return;
  }
  const reload = () => renderComments(container, post, onCountChange);
  if (post.commentCount !== list.length) {
    post.commentCount = list.length;
    onCountChange();
  }

  const error = h('p', { class: 'error', role: 'alert', id: newId('error') });
  const input = h('input', { id: newId('comment'), placeholder: 'Write a comment…', autocomplete: 'off' });
  const { counter, update } = lengthCounter(input);
  input.setAttribute('aria-describedby', `${counter.id} ${error.id}`);
  input.addEventListener('input', () => {
    update();
    if (input.value.trim()) error.textContent = '';
  });
  const submit = h('button', { type: 'submit' }, 'Reply');
  const form = h('form', {
    class: 'comment-form',
    onsubmit: (e) => {
      e.preventDefault();
      const { length, over } = update();
      if (!length || over) {
        error.textContent = length ? `Comments are limited to ${MAX_POST_LENGTH} characters.` : 'Write a comment first.';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      runAction(submit, error, async () => {
        await api('POST', `/api/posts/${post.id}/comments`, { body: input.value });
        announce('Comment added.');
        await reload();
        container.querySelector('.comment-form input')?.focus();
      });
    },
  }, h('label', { for: input.id, class: 'visually-hidden' }, 'Write a comment'), input, submit);
  const note = h('p', { class: 'muted comment-note' },
    post.mine
      ? 'You see every comment here; others see only the comments written by their friends.'
      : `Your comment is seen by @${post.username} and by your friends who can see this post.`);

  const listEl = h('ul', { class: 'comment-list', 'aria-label': 'Comments', hidden: !list.length });
  const none = h('p', { class: 'muted comment-status', hidden: list.length > 0 }, 'No comments yet.');

  // Deleting takes just that comment out, and moves focus to the next one (or the reply box).
  const deleteButton = (c, item) => {
    const button = h('button', {
      class: 'link comment-delete',
      'aria-label': 'Delete comment',
      onclick: () => {
        if (!confirm('Delete this comment?')) return;
        runAction(button, error, async () => {
          await api('DELETE', `/api/comments/${c.id}`);
          const next = item.nextElementSibling ?? item.previousElementSibling;
          item.remove();
          post.commentCount = Math.max(0, post.commentCount - 1);
          onCountChange();
          if (!listEl.children.length) {
            listEl.hidden = true;
            none.hidden = false;
          }
          announce('Comment deleted.');
          focusElement(next?.querySelector('a[href], button') ?? input);
        });
      },
    }, 'Delete');
    return button;
  };

  for (const c of list) {
    const item = h('li', { class: 'comment' });
    item.append(
      h('div', { class: 'post-head' },
        h('a', { class: 'author', href: `#/u/${encodeURIComponent(c.username)}` }, `@${c.username}`),
        timestamp(c.createdAt),
        c.canDelete && deleteButton(c, item),
      ),
      h('p', { class: 'comment-body' }, c.body),
    );
    listEl.append(item);
  }

  container.replaceChildren(listEl, none, form, h('div', { class: 'comment-meta' }, counter), note, error);
}

// Show the first page of posts; `opts.fetchPage(cursor)` loads later pages ({ posts, nextCursor }).
function renderPostList(container, { posts, nextCursor }, opts) {
  if (!posts.length) {
    container.replaceChildren(statusMessage(opts.emptyText));
    return;
  }
  // Take a deleted post's card out and move focus to the next one (or the previous one).
  const onDeleted = (card) => {
    const next = card.nextElementSibling ?? card.previousElementSibling;
    card.remove();
    announce('Post deleted.');
    if (next) {
      focusElement(next.querySelector('a[href], button'));
    } else {
      container.replaceChildren(statusMessage(opts.emptyText));
      focusElement(app.querySelector('h1'));
    }
  };
  const item = (p) => renderPost(p, { ...opts, onDeleted });
  container.replaceChildren(...posts.map(item));
  appendLoadMore(container, nextCursor, async (cursor) => {
    const page = await opts.fetchPage(cursor);
    return { items: page.posts ?? [], nextCursor: page.nextCursor ?? null };
  }, item);
}

function composeBox(onPosted) {
  // No maxlength: a long paste stays whole, and the counter says how far over the limit it is.
  const text = h('textarea', { id: newId('compose'), placeholder: "What's happening?" });
  const { counter, update } = lengthCounter(text);
  const shortcut = h('span', { class: 'hint shortcut-hint', id: newId('hint') },
    `${IS_MAC ? '⌘' : 'Ctrl'}+Enter to post`);
  const submit = h('button', {
    type: 'submit',
    disabled: true,
    'aria-keyshortcuts': IS_MAC ? 'Meta+Enter' : 'Control+Enter',
  }, 'Post');
  const error = h('p', { class: 'error', role: 'alert', id: newId('error') });
  text.setAttribute('aria-describedby', `${counter.id} ${shortcut.id} ${error.id}`);

  const refresh = () => {
    const { length, over } = update();
    submit.disabled = length === 0 || over;
  };
  text.addEventListener('input', refresh);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.textContent = '';
      try {
        await api('POST', '/api/posts', { body: text.value });
        text.value = '';
        refresh();
        announce('Posted.');
        onPosted();
      } catch (err) {
        error.textContent = err.message;
        refresh();
      }
    },
  },
  h('label', { for: text.id, class: 'visually-hidden' }, 'Write a post'),
  text,
  h('div', { class: 'compose-footer' }, shortcut, counter, submit),
  error);
  return form;
}

// ---------- Home view ----------

function renderHome() {
  const current = startView();
  setTitle('Home');
  const heading = h('h1', { class: 'view-title' }, 'Home');
  const list = h('div', {}, statusMessage('Loading…'));
  const search = h('input', { type: 'search', maxlength: MAX_SEARCH_LENGTH, placeholder: 'Search posts from you and your friends…' });
  const nextRequest = latestOnly();

  const feedUrl = (term, cursor) => {
    const params = new URLSearchParams();
    if (term) params.set('q', term);
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return `/api/feed${query ? `?${query}` : ''}`;
  };

  const load = async () => {
    const isLatest = nextRequest();
    const term = search.value.trim();
    let page;
    try {
      page = await api('GET', feedUrl(term));
    } catch (err) {
      if (isLatest() && current()) showLoadError(list, err, load);
      return;
    }
    if (!isLatest() || !current()) return;
    renderPostList(list, page, {
      searchTerm: term,
      fetchPage: (cursor) => api('GET', feedUrl(term, cursor)),
      emptyText: term
        ? `No posts match “${term}”.`
        : 'Nothing here yet. Write your first post, or add some friends!',
    });
    // Results change while typing, so say what happened.
    if (term) {
      const count = page.posts.length;
      announce(count
        ? `${count}${page.nextCursor ? '+' : ''} matching post${count === 1 && !page.nextCursor ? '' : 's'}.`
        : `No posts match “${term}”.`);
    }
  };

  search.addEventListener('input', debounce(load, 250));
  app.replaceChildren(
    heading,
    composeBox(() => { search.value = ''; load(); }),
    searchForm(search, 'Search posts', load),
    list,
  );
  focusView(heading);
  load();
}

// ---------- Profile view ----------

// Buttons for managing the friendship with `username`, based on the current relation.
// Each button sends its intent, so a stale button (e.g. "Accept" after they canceled their
// request) fails with an error instead of doing something else. After a change, the result
// is announced and `onChange(newRelation)` is called.
function friendActions(username, relation, onChange) {
  const error = h('span', { class: 'error compact', role: 'alert' });
  const name = encodeURIComponent(username);
  const act = (method, url, intent, label, { cls, confirmText, done }) => {
    const button = h('button', {
      class: cls,
      // Rows of identical buttons need to say whom they're for.
      'aria-label': `${label} @${username}`,
      onclick: () => {
        if (confirmText && !confirm(confirmText)) return;
        runAction(button, error, async () => {
          let result;
          try {
            result = await api(method, url, intent ? { intent } : undefined);
          } finally {
            refreshBadge();
          }
          announce(result.relation === 'friends' ? `You’re now friends with @${username}.` : done);
          onChange(result.relation);
        });
      },
    }, label);
    return button;
  };
  const friends = `/api/friends/${name}`;

  switch (relation) {
    case 'friends': return [act('DELETE', friends, 'unfriend', 'Unfriend', {
      cls: 'danger',
      confirmText: `Unfriend @${username}? You’ll no longer see each other’s posts.`,
      done: `Unfriended @${username}.`,
    }), error];
    case 'outgoing': return [act('DELETE', friends, 'cancel', 'Cancel request', {
      cls: 'secondary',
      done: `Canceled your friend request to @${username}.`,
    }), error];
    case 'incoming': return [
      act('POST', friends, 'accept', 'Accept', {}),
      act('DELETE', friends, 'decline', 'Decline', {
        cls: 'secondary',
        confirmText: `Decline @${username}’s friend request? They won’t be able to ask again for 30 days.`,
        done: `Declined @${username}’s friend request.`,
      }),
      error,
    ];
    case 'none': return [act('POST', friends, 'request', 'Add friend', { done: `Friend request sent to @${username}.` }), error];
    case 'blocked': return [act('DELETE', `/api/blocks/${name}`, null, 'Unblock', {
      cls: 'secondary',
      done: `Unblocked @${username}.`,
    }), error];
    default: return [];
  }
}

// "Block" button for a profile. Blocking ends any friendship or request, and hides you from them.
function blockButton(username, onChange) {
  const button = h('button', {
    class: 'danger',
    'aria-label': `Block @${username}`,
    onclick: () => {
      if (!confirm(`Block @${username}? This ends any friendship or request between you, and they won’t be able to see your profile, find you or send you requests.`)) return;
      runAction(button, null, async () => {
        await api('POST', `/api/blocks/${encodeURIComponent(username)}`);
        announce(`Blocked @${username}.`);
        refreshBadge();
        onChange();
      });
    },
  }, 'Block');
  return button;
}

// `joined` is "YYYY-MM" (or null if hidden). Built from parts, so it's the same month in every time zone.
function joinedText(joined) {
  if (!joined) return null;
  const [year, month] = joined.split('-').map(Number);
  return `Joined ${new Date(year, month - 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
}

// `focusActions`: after a friend action, put focus back on the (new) action buttons.
async function renderProfile(username, { focusActions = false } = {}) {
  const current = startView();
  setTitle(`@${username}`);
  const reload = (options) => renderProfile(username, options);
  const profileUrl = (cursor) =>
    `/api/users/${encodeURIComponent(username)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;

  app.replaceChildren(statusMessage('Loading…'));
  let profile;
  try {
    profile = await api('GET', profileUrl());
  } catch (err) {
    if (current()) showLoadError(app, err, () => reload());
    return;
  }
  if (!current()) return;

  const status = {
    friends: 'Friends',
    outgoing: 'Friend request sent',
    incoming: 'Wants to be your friend',
    declined: 'Declined your friend request',
    blocked: 'Blocked',
  }[profile.relation];
  const details = [joinedText(profile.joined), status].filter(Boolean).join(' · ');
  const isSelf = profile.relation === 'self';
  const canBlock = !['self', 'blocked'].includes(profile.relation);
  const afterAction = () => reload({ focusActions: true });

  const heading = h('h1', {}, `@${profile.username}`);
  const actions = h('div', { class: 'actions' },
    friendActions(profile.username, profile.relation, afterAction),
    canBlock && blockButton(profile.username, afterAction),
    isSelf && h('a', { class: 'button', href: '#/account' }, 'Account & privacy'));

  const list = h('div');
  const showPosts = (page) => renderPostList(list, page, {
    fetchPage: (cursor) => api('GET', profileUrl(cursor)),
    emptyText: isSelf ? "You haven't posted yet." : `@${profile.username} hasn't posted yet.`,
  });
  // After posting, refresh only the list, so the composer (and focus in it) stays put.
  const reloadPosts = async () => {
    try {
      const page = await api('GET', profileUrl());
      if (list.isConnected) showPosts(page);
    } catch (err) {
      if (list.isConnected) showLoadError(list, err, reloadPosts);
    }
  };

  const children = [
    h('div', { class: 'card' },
      h('div', { class: 'profile-head' },
        h('div', { class: 'profile-name' },
          heading,
          details && h('p', { class: 'muted profile-details' }, details),
        ),
        actions,
      ),
    ),
  ];
  if (isSelf) children.push(composeBox(reloadPosts));
  children.push(list);
  app.replaceChildren(...children);

  if (profile.posts) {
    showPosts(profile);
  } else if (profile.relation === 'blocked') {
    list.replaceChildren(statusMessage(`You’ve blocked @${profile.username}.`));
  } else {
    list.replaceChildren(statusMessage(`Become friends with @${profile.username} to see their posts.`));
  }

  if (focusActions) focusElement(actions.querySelector('button, a[href]') ?? heading);
  else focusView(heading);
}

// ---------- Friends view ----------

// "Find people" only lists users you have no friendship or request with (filtered by the server).
const peopleUrl = (q, cursor) => {
  const params = new URLSearchParams({ relation: 'none' });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return `/api/users?${params}`;
};

function renderFriends() {
  const current = startView();
  setTitle('Friends');
  const heading = h('h1', { class: 'view-title' }, 'Friends');
  const lists = h('div', {}, statusMessage('Loading…'));

  // (Re)load the friend and request lists; the "Find people" search below is left alone.
  // `focus` ({ name, key }), after a friend action: focus that person's new row if they still
  // have one, or else the heading of the section they were in.
  const loadLists = async (focus) => {
    let data;
    try {
      data = await api('GET', '/api/friends');
    } catch (err) {
      if (current()) showLoadError(lists, err, () => loadLists(focus));
      return;
    }
    if (!current()) return;

    const section = (key, title, names, relation, emptyText) =>
      h('section', { class: 'card', 'data-key': key },
        h('h2', {}, `${title} (${names.length})`),
        names.length
          ? h('ul', { class: 'user-list' }, names.map((name) =>
              userRow(name, friendActions(name, relation, () => loadLists({ name, key })))))
          : h('p', { class: 'muted flush' }, emptyText),
      );

    lists.replaceChildren(
      data.incoming.length ? section('incoming', 'Friend requests', data.incoming, 'incoming', '') : '',
      section('friends', 'Friends', data.friends, 'friends', 'No friends yet — find people below.'),
      data.outgoing.length ? section('outgoing', 'Sent requests', data.outgoing, 'outgoing', '') : '',
    );
    if (focus) {
      const row = [...lists.querySelectorAll('.user-row')].find((r) => r.dataset.username === focus.name);
      focusElement(row?.querySelector('button')
        ?? lists.querySelector(`[data-key="${focus.key}"] h2`)
        ?? heading);
    }
  };

  const peopleList = h('ul', { class: 'user-list' });
  const findStatus = h('p', { class: 'muted find-status', role: 'status' });
  const setFindStatus = (text, isError = false) => {
    findStatus.textContent = text;
    findStatus.className = `find-status ${isError ? 'error' : 'muted'}`;
  };
  // A search result updates in place after an action (e.g. "Add friend" becomes "Cancel
  // request"), so the search isn't lost; the lists above are refreshed too.
  const personRow = (u) => {
    const row = userRow(u.username, []);
    const actions = row.querySelector('.actions');
    const show = (relation, focus) => {
      actions.replaceChildren(...friendActions(u.username, relation, (next) => {
        show(next, true);
        loadLists();
      }));
      if (focus) focusElement(actions.querySelector('button'));
    };
    show(u.relation, false);
    return row;
  };
  const showPeople = (page, q) => {
    const count = page.users.length;
    peopleList.replaceChildren(...page.users.map(personRow));
    setFindStatus(count
      ? `${count}${page.nextCursor ? '+' : ''} ${count === 1 && !page.nextCursor ? 'person' : 'people'} found.`
      : `No one new to add whose username starts with “${q}”. Your friends, people with a pending request `
        + 'and people you’ve blocked aren’t listed here.');
    appendLoadMore(peopleList, page.nextCursor, async (cursor) => {
      const next = await api('GET', peopleUrl(q, cursor));
      return { items: next.users, nextCursor: next.nextCursor };
    }, personRow);
  };

  const findInput = h('input', { type: 'search', maxlength: MAX_SEARCH_LENGTH, placeholder: 'Find people by username…', autocomplete: 'off' });
  const searchHint = () => {
    peopleList.replaceChildren();
    setFindStatus(`Type the first ${MIN_USER_SEARCH_LENGTH} or more letters of their username.`);
  };
  const nextSearch = latestOnly();
  const find = async () => {
    const isLatest = nextSearch();
    const q = findInput.value.trim();
    if (q.length < MIN_USER_SEARCH_LENGTH) return searchHint();
    try {
      const page = await api('GET', peopleUrl(q));
      if (isLatest()) showPeople(page, q);
    } catch (err) {
      if (isLatest()) {
        peopleList.replaceChildren();
        setFindStatus(err.message, true);
      }
    }
  };
  findInput.addEventListener('input', debounce(find, 250));
  searchHint();

  app.replaceChildren(
    heading,
    lists,
    h('section', { class: 'card' },
      h('h2', {}, 'Find people'),
      searchForm(findInput, 'Find people by username', find),
      findStatus,
      peopleList),
  );
  focusView(heading);
  loadLists();
}

// ---------- Account view ----------

async function renderAccount() {
  const current = startView();
  setTitle('Account & privacy');
  const heading = h('h1', { class: 'view-title' }, 'Account & privacy');
  const content = h('div', {}, statusMessage('Loading…'));
  app.replaceChildren(heading, content);
  focusView(heading);

  let lists;
  try {
    lists = await api('GET', '/api/friends');
  } catch (err) {
    if (current()) showLoadError(content, err, () => renderAccount());
    return;
  }
  if (!current()) return;

  // The blocked list updates in place; after an unblock, focus moves to the next row.
  const blockedSection = h('section', { class: 'card' });
  const showBlocked = (names, focusIndex) => {
    const title = h('h2', {}, `Blocked (${names.length})`);
    const rows = names.map((name, i) =>
      userRow(name, friendActions(name, 'blocked', () => showBlocked(names.filter((n) => n !== name), i))));
    blockedSection.replaceChildren(title, names.length
      ? h('ul', { class: 'user-list' }, rows)
      : h('p', { class: 'muted flush' }, 'You haven’t blocked anyone. Use “Block” on a profile.'));
    if (focusIndex != null) focusElement(rows[Math.min(focusIndex, rows.length - 1)]?.querySelector('button') ?? title);
  };
  showBlocked(lists.blocked);

  const logoutAllError = h('p', { class: 'error compact', role: 'alert' });
  const logoutAll = h('button', {
    class: 'secondary',
    onclick: () => {
      if (!confirm('Log out of Chirp on every device, including this one?')) return;
      runAction(logoutAll, logoutAllError, async () => {
        await api('POST', '/api/logout-all');
        me = null;
        navigate('#/');
      });
    },
  }, 'Log out everywhere');

  const deleteError = h('p', { class: 'error', role: 'alert', id: newId('error') });
  const password = h('input', {
    id: newId('password'),
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    'aria-describedby': deleteError.id,
    oninput: () => password.removeAttribute('aria-invalid'),
  });
  const deleteBtn = h('button', { type: 'submit', class: 'danger' }, 'Delete my account');
  const deleteForm = h('form', {
    class: 'account-delete',
    onsubmit: (e) => {
      e.preventDefault();
      if (!confirm('Permanently delete your account, posts, comments, likes and friendships? This can’t be undone.')) return;
      runAction(deleteBtn, deleteError, async () => {
        try {
          await api('DELETE', '/api/me', { password: password.value });
        } catch (err) {
          if (err.status === 403) {
            password.setAttribute('aria-invalid', 'true');
            password.focus();
          }
          throw err;
        }
        me = null;
        navigate('#/');
      });
    },
  }, h('label', { for: password.id }, 'Password'), password, deleteBtn, deleteError);

  content.replaceChildren(
    h('section', { class: 'card' }, h('h2', {}, 'Privacy'), privacyNotice()),
    h('section', { class: 'card' },
      h('h2', {}, 'Your data'),
      h('p', { class: 'muted section-intro' }, 'Download your account details, posts, comments, likes and friendships as a JSON file.'),
      h('a', { class: 'button', href: '/api/me/export', download: '' }, 'Download my data'),
    ),
    blockedSection,
    h('section', { class: 'card' },
      h('h2', {}, 'Sessions'),
      h('p', { class: 'muted section-intro' }, 'Still logged in on a device you don’t use any more? Log out on every device at once, including this one.'),
      logoutAll,
      logoutAllError,
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Delete account'),
      h('p', { class: 'muted section-intro' }, 'This erases your account and everything you’ve posted, including comments on other people’s posts. Enter your password to confirm.'),
      deleteForm,
    ),
  );
}

// ---------- Router ----------

function render() {
  renderNav();
  if (!me) return renderAuth();
  const route = location.hash.slice(1) || '/';
  const profileMatch = route.match(/^\/u\/(.+)$/);
  if (profileMatch) return renderProfile(safeDecode(profileMatch[1]));
  if (route === '/friends') return renderFriends();
  if (route === '/account') return renderAccount();
  return renderHome();
}

window.addEventListener('hashchange', () => {
  focusPending = true;
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

// On startup, a failure other than 401 (e.g. offline) shows Retry instead of the login form.
async function start() {
  try {
    await refreshMe();
  } catch (err) {
    startView();
    showLoadError(app, err, start);
    return;
  }
  render();
}

start();
