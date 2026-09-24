const MAX_POST_LENGTH = 280;
const MAX_SEARCH_LENGTH = 100; // Longer searches are refused by the server.
const BADGE_POLL_MS = 60 * 1000;
const app = document.getElementById('app');
const nav = document.getElementById('nav');
let me = null; // { username, pendingRequests }
let viewToken = 0; // Bumped whenever a view starts rendering; see startView().

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
function showLoadError(container, err, retry) {
  container.replaceChildren(h('div', { class: 'card empty' },
    h('p', { style: 'margin:0' }, err.status === 404 ? err.message : `Couldn't load: ${err.message}`),
    err.status !== 404 && h('button', { class: 'secondary', style: 'margin-top:10px', onclick: retry }, 'Retry'),
  ));
}

// Append a "Load more" button to `container`. Clicking it calls `fetchPage(cursor)`, which
// resolves to { items, nextCursor }, and appends each item rendered with `renderItem`.
function appendLoadMore(container, cursor, fetchPage, renderItem) {
  if (!cursor) return;
  const error = h('p', { class: 'error compact' });
  const button = h('button', {
    class: 'secondary',
    onclick: () => runAction(button, error, async () => {
      const page = await fetchPage(cursor);
      if (!more.isConnected) return; // The list was replaced (new search, navigation) meanwhile.
      more.replaceWith(...page.items.map(renderItem));
      appendLoadMore(container, page.nextCursor, fetchPage, renderItem);
    }),
  }, 'Load more');
  const more = h('div', { class: 'load-more' }, button, error);
  container.append(more);
}

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, size] of units) {
    if (seconds >= size) {
      if (label === 'd' && seconds >= 7 * 86400) break;
      return `${Math.floor(seconds / size)}${label}`;
    }
  }
  return new Date(iso).toLocaleDateString();
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

// Go to `hash` and render once: setting a new hash renders via hashchange, so only
// render directly when we're already there.
function navigate(hash) {
  if ((location.hash || '#/') === hash) render();
  else location.hash = hash;
}

// ---------- Nav ----------

function renderNav() {
  if (!me) {
    nav.hidden = true;
    return;
  }
  const route = location.hash || '#/';
  const link = (href, label, extra) =>
    h('a', { href, class: `nav-link${route === href ? ' active' : ''}` }, label, extra);

  const logout = h('button', {
    class: 'link',
    onclick: () => runAction(logout, null, async () => {
      await api('POST', '/api/logout');
      me = null;
      navigate('#/');
    }),
  }, 'Log out');

  nav.hidden = false;
  nav.replaceChildren(h('div', { class: 'nav-inner' },
    h('a', { href: '#/', class: 'brand' }, 'Chirp'),
    link('#/', 'Home'),
    link('#/friends', 'Friends', me.pendingRequests ? h('span', { class: 'badge' }, me.pendingRequests) : null),
    link(`#/u/${encodeURIComponent(me.username)}`, `@${me.username}`),
    logout,
  ));
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

function renderAuth(mode = 'login') {
  startView();
  const isLogin = mode === 'login';
  const error = h('p', { class: 'error' });
  const username = h('input', { name: 'username', placeholder: 'Username', autocomplete: 'username', required: true });
  const password = h('input', {
    name: 'password',
    type: 'password',
    placeholder: 'Password',
    autocomplete: isLogin ? 'current-password' : 'new-password',
    required: true,
  });
  const submit = h('button', { type: 'submit' }, isLogin ? 'Log in' : 'Create account');

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      runAction(submit, error, async () => {
        await api('POST', isLogin ? '/api/login' : '/api/signup', {
          username: username.value,
          password: password.value,
        });
        await refreshMe();
        render(); // Keep the current hash, so a deep link like #/friends survives logging in.
      });
    },
  }, username, password, submit, error);

  app.replaceChildren(h('div', { class: 'auth' },
    h('h1', {}, 'Chirp'),
    h('div', { class: 'card' },
      h('h2', {}, isLogin ? 'Log in' : 'Sign up'),
      form,
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

function renderPost(post, { searchTerm, onChange }) {
  const error = h('p', { class: 'error compact' });
  const likeBtn = h('button', {
    class: `link like-btn${post.liked ? ' liked' : ''}`,
    'aria-pressed': String(post.liked),
    onclick: () => runAction(likeBtn, error, async () => {
      // Use the server's answer rather than flipping locally, so counts can't drift.
      const state = await api(post.liked ? 'DELETE' : 'POST', `/api/posts/${post.id}/like`);
      post.liked = state.liked;
      post.likeCount = state.likeCount;
      likeBtn.classList.toggle('liked', post.liked);
      likeBtn.setAttribute('aria-pressed', String(post.liked));
      likeBtn.textContent = `${post.liked ? '♥' : '♡'} ${post.likeCount}`;
    }),
  }, `${post.liked ? '♥' : '♡'} ${post.likeCount}`);

  const comments = h('div', { class: 'comments', hidden: true });
  const commentLabel = () => `💬 ${post.commentCount}`;
  const commentBtn = h('button', {
    class: 'link',
    'aria-expanded': 'false',
    onclick: () => {
      const opening = comments.hidden;
      comments.hidden = !opening;
      commentBtn.setAttribute('aria-expanded', String(opening));
      if (opening) renderComments(comments, post, () => { commentBtn.textContent = commentLabel(); });
    },
  }, commentLabel());

  const deleteBtn = post.mine && h('button', {
    class: 'link',
    onclick: () => {
      if (!confirm('Delete this post?')) return;
      runAction(deleteBtn, error, async () => {
        await api('DELETE', `/api/posts/${post.id}`);
        onChange();
      });
    },
  }, 'Delete');

  return h('article', { class: 'card' },
    h('div', { class: 'post-head' },
      h('a', { class: 'author', href: `#/u/${encodeURIComponent(post.username)}` }, `@${post.username}`),
      h('time', { datetime: post.createdAt, title: new Date(post.createdAt).toLocaleString() }, timeAgo(post.createdAt)),
    ),
    h('p', { class: 'post-body' }, highlight(post.body, searchTerm)),
    h('div', { class: 'post-actions' }, likeBtn, commentBtn, deleteBtn),
    error,
    comments,
  );
}

// Load and show the comment thread for `post` inside `container`, with a reply box.
// `onCountChange` is called whenever post.commentCount changes.
async function renderComments(container, post, onCountChange) {
  container.replaceChildren(h('p', { class: 'muted comment-status' }, 'Loading comments…'));
  let list;
  try {
    list = await api('GET', `/api/posts/${post.id}/comments`);
  } catch (err) {
    container.replaceChildren(h('p', { class: 'error' }, err.message));
    return;
  }
  const reload = () => renderComments(container, post, onCountChange);
  if (post.commentCount !== list.length) {
    post.commentCount = list.length;
    onCountChange();
  }

  const input = h('input', { placeholder: 'Write a comment…', maxlength: MAX_POST_LENGTH, 'aria-label': 'Write a comment' });
  const submit = h('button', { type: 'submit' }, 'Reply');
  const error = h('p', { class: 'error' });
  const form = h('form', {
    class: 'comment-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      submit.disabled = true;
      error.textContent = '';
      try {
        await api('POST', `/api/posts/${post.id}/comments`, { body: input.value });
        await reload();
        container.querySelector('.comment-form input')?.focus();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    },
  }, input, submit);

  const deleteButton = (c) => {
    const button = h('button', {
      class: 'link comment-delete',
      onclick: () => {
        if (!confirm('Delete this comment?')) return;
        runAction(button, error, async () => {
          await api('DELETE', `/api/comments/${c.id}`);
          await reload();
        });
      },
    }, 'Delete');
    return button;
  };

  container.replaceChildren(
    ...list.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'post-head' },
        h('a', { class: 'author', href: `#/u/${encodeURIComponent(c.username)}` }, `@${c.username}`),
        h('time', { datetime: c.createdAt, title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt)),
        c.canDelete && deleteButton(c),
      ),
      h('p', { class: 'comment-body' }, c.body),
    )),
    ...(list.length ? [] : [h('p', { class: 'muted comment-status' }, 'No comments yet.')]),
    form,
    error,
  );
}

// Show the first page of posts; `opts.fetchPage(cursor)` loads later pages ({ posts, nextCursor }).
function renderPostList(container, { posts, nextCursor }, opts) {
  if (!posts.length) {
    container.replaceChildren(h('p', { class: 'empty' }, opts.emptyText));
    return;
  }
  const item = (p) => renderPost(p, opts);
  container.replaceChildren(...posts.map(item));
  appendLoadMore(container, nextCursor, async (cursor) => {
    const page = await opts.fetchPage(cursor);
    return { items: page.posts ?? [], nextCursor: page.nextCursor ?? null };
  }, item);
}

function composeBox(onPosted) {
  const text = h('textarea', { placeholder: "What's happening?", maxlength: MAX_POST_LENGTH * 2 });
  const counter = h('span', { class: 'counter' }, `0 / ${MAX_POST_LENGTH}`);
  const submit = h('button', { type: 'submit', disabled: true }, 'Post');
  const error = h('p', { class: 'error' });

  const update = () => {
    const len = text.value.trim().length;
    counter.textContent = `${text.value.length} / ${MAX_POST_LENGTH}`;
    counter.classList.toggle('over', text.value.length > MAX_POST_LENGTH);
    submit.disabled = len === 0 || text.value.length > MAX_POST_LENGTH;
  };
  text.addEventListener('input', update);
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
        update();
        onPosted();
      } catch (err) {
        error.textContent = err.message;
        update();
      }
    },
  }, text, h('div', { class: 'compose-footer' }, counter, submit), error);
  return form;
}

// ---------- Home view ----------

function renderHome() {
  const current = startView();
  const list = h('div', {}, h('p', { class: 'empty' }, 'Loading…'));
  const search = h('input', { type: 'search', class: 'search', maxlength: MAX_SEARCH_LENGTH, placeholder: 'Search posts from you and your friends…' });
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
      onChange: load,
      fetchPage: (cursor) => api('GET', feedUrl(term, cursor)),
      emptyText: term
        ? `No posts match “${term}”.`
        : 'Nothing here yet. Write your first post, or add some friends!',
    });
  };

  search.addEventListener('input', debounce(load, 250));
  app.replaceChildren(composeBox(() => { search.value = ''; load(); }), search, list);
  load();
}

// ---------- Profile view ----------

// Buttons for managing the friendship with `username`, based on the current relation.
// Each button sends its intent, so a stale button (e.g. "Accept" after they canceled their
// request) fails with an error instead of doing something else.
function friendActions(username, relation, onChange) {
  const error = h('span', { class: 'error compact' });
  const act = (method, intent, label, cls) => {
    const button = h('button', {
      class: cls,
      onclick: () => runAction(button, error, async () => {
        try {
          await api(method, `/api/friends/${encodeURIComponent(username)}`, { intent });
        } finally {
          refreshBadge();
        }
        onChange();
      }),
    }, label);
    return button;
  };

  switch (relation) {
    case 'friends': return [act('DELETE', 'unfriend', 'Unfriend', 'danger'), error];
    case 'outgoing': return [act('DELETE', 'cancel', 'Cancel request', 'secondary'), error];
    case 'incoming': return [act('POST', 'accept', 'Accept'), act('DELETE', 'decline', 'Decline', 'secondary'), error];
    case 'none': return [act('POST', 'request', 'Add friend'), error];
    default: return [];
  }
}

async function renderProfile(username) {
  const current = startView();
  const reload = () => renderProfile(username);
  const profileUrl = (cursor) =>
    `/api/users/${encodeURIComponent(username)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;

  app.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  let profile;
  try {
    profile = await api('GET', profileUrl());
  } catch (err) {
    if (current()) showLoadError(app, err, reload);
    return;
  }
  if (!current()) return;

  const status = {
    friends: 'Friends',
    outgoing: 'Friend request sent',
    incoming: 'Wants to be your friend',
  }[profile.relation];

  const list = h('div');
  const children = [
    h('div', { class: 'card' },
      h('div', { class: 'profile-head' },
        h('div', {},
          h('h1', {}, `@${profile.username}`),
          h('p', { class: 'muted', style: 'margin:4px 0 0' },
            `Joined ${new Date(profile.joined).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`,
            status ? ` · ${status}` : ''),
        ),
        h('div', { class: 'actions' }, friendActions(profile.username, profile.relation, reload)),
      ),
    ),
  ];

  if (profile.relation === 'self') children.push(composeBox(reload));
  children.push(list);
  app.replaceChildren(...children);

  if (profile.posts) {
    renderPostList(list, profile, {
      onChange: reload,
      fetchPage: (cursor) => api('GET', profileUrl(cursor)),
      emptyText: profile.relation === 'self' ? "You haven't posted yet." : `@${profile.username} hasn't posted yet.`,
    });
  } else {
    list.replaceChildren(h('p', { class: 'empty' }, `Become friends with @${profile.username} to see their posts.`));
  }
}

// ---------- Friends view ----------

// "Find people" only lists users you have no friendship or request with (filtered by the server).
const peopleUrl = (q, cursor) => {
  const params = new URLSearchParams({ relation: 'none' });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return `/api/users?${params}`;
};

async function renderFriends() {
  const current = startView();
  const reload = () => renderFriends();

  app.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  let lists, people;
  try {
    [lists, people] = await Promise.all([api('GET', '/api/friends'), api('GET', peopleUrl(''))]);
  } catch (err) {
    if (current()) showLoadError(app, err, reload);
    return;
  }
  if (!current()) return;

  const section = (title, names, relation, emptyText) =>
    h('section', { class: 'card' },
      h('h2', {}, `${title} (${names.length})`),
      names.length
        ? names.map((name) => h('div', { class: 'user-row' },
            userLink(name),
            h('div', { class: 'actions' }, friendActions(name, relation, reload))))
        : h('p', { class: 'muted', style: 'margin:0' }, emptyText),
    );

  const peopleList = h('div');
  const personRow = (u) => h('div', { class: 'user-row' },
    userLink(u.username),
    h('div', { class: 'actions' }, friendActions(u.username, u.relation, reload)));
  const showPeople = (page, q) => {
    peopleList.replaceChildren(...(page.users.length
      ? page.users.map(personRow)
      : [h('p', { class: 'muted', style: 'margin:0' }, q ? `No one matches “${q}”.` : 'No one else to add.')]));
    appendLoadMore(peopleList, page.nextCursor, async (cursor) => {
      const next = await api('GET', peopleUrl(q, cursor));
      return { items: next.users, nextCursor: next.nextCursor };
    }, personRow);
  };

  const findInput = h('input', { type: 'search', maxlength: MAX_SEARCH_LENGTH, placeholder: 'Find people by username…', style: 'margin-bottom:8px' });
  const nextSearch = latestOnly();
  findInput.addEventListener('input', debounce(async () => {
    const isLatest = nextSearch();
    const q = findInput.value.trim();
    try {
      const page = await api('GET', peopleUrl(q));
      if (isLatest()) showPeople(page, q);
    } catch (err) {
      if (isLatest()) peopleList.replaceChildren(h('p', { class: 'error' }, err.message));
    }
  }, 250));
  showPeople(people, '');

  app.replaceChildren(
    lists.incoming.length ? section('Friend requests', lists.incoming, 'incoming', '') : '',
    section('Friends', lists.friends, 'friends', 'No friends yet — add some below.'),
    lists.outgoing.length ? section('Sent requests', lists.outgoing, 'outgoing', '') : '',
    h('section', { class: 'card' }, h('h2', {}, 'Find people'), findInput, peopleList),
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
  return renderHome();
}

window.addEventListener('hashchange', () => {
  render();
  refreshBadge();
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshBadge();
}, BADGE_POLL_MS);

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
