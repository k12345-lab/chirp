const MAX_POST_LENGTH = 280;
const app = document.getElementById('app');
const nav = document.getElementById('nav');
let me = null; // { username, pendingRequests }

// ---------- Helpers ----------

// Tiny DOM builder. Strings become text nodes, so user content is never parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
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

// Split text into plain and <mark>ed pieces for the search term.
function highlight(text, term) {
  if (!term) return [text];
  const parts = [];
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let i = 0;
  while (true) {
    const found = lower.indexOf(needle, i);
    if (found === -1) break;
    parts.push(text.slice(i, found), h('mark', {}, text.slice(found, found + needle.length)));
    i = found + needle.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const userLink = (username) => h('a', { href: `#/u/${encodeURIComponent(username)}` }, username);

// ---------- Nav ----------

function renderNav() {
  if (!me) {
    nav.hidden = true;
    return;
  }
  const route = location.hash || '#/';
  const link = (href, label, extra) =>
    h('a', { href, class: `nav-link${route === href ? ' active' : ''}` }, label, extra);

  nav.hidden = false;
  nav.replaceChildren(h('div', { class: 'nav-inner' },
    h('a', { href: '#/', class: 'brand' }, 'Chirp'),
    link('#/', 'Home'),
    link('#/friends', 'Friends', me.pendingRequests ? h('span', { class: 'badge' }, me.pendingRequests) : null),
    link(`#/u/${encodeURIComponent(me.username)}`, `@${me.username}`),
    h('button', {
      class: 'link',
      onclick: async () => {
        await api('POST', '/api/logout');
        me = null;
        location.hash = '#/';
        render();
      },
    }, 'Log out'),
  ));
}

async function refreshMe() {
  try {
    me = await api('GET', '/api/me');
  } catch {
    me = null;
  }
  renderNav();
}

// ---------- Auth view ----------

function renderAuth(mode = 'login') {
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
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        await api('POST', isLogin ? '/api/login' : '/api/signup', {
          username: username.value,
          password: password.value,
        });
        await refreshMe();
        location.hash = '#/';
        render();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
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
  const likeBtn = h('button', {
    class: `link like-btn${post.liked ? ' liked' : ''}`,
    'aria-pressed': String(post.liked),
    onclick: async () => {
      likeBtn.disabled = true;
      try {
        await api(post.liked ? 'DELETE' : 'POST', `/api/posts/${post.id}/like`);
        post.liked = !post.liked;
        post.likeCount += post.liked ? 1 : -1;
        likeBtn.classList.toggle('liked', post.liked);
        likeBtn.setAttribute('aria-pressed', String(post.liked));
        likeBtn.textContent = `${post.liked ? '♥' : '♡'} ${post.likeCount}`;
      } finally {
        likeBtn.disabled = false;
      }
    },
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
    onclick: async () => {
      if (!confirm('Delete this post?')) return;
      await api('DELETE', `/api/posts/${post.id}`);
      onChange();
    },
  }, 'Delete');

  return h('article', { class: 'card' },
    h('div', { class: 'post-head' },
      h('a', { class: 'author', href: `#/u/${encodeURIComponent(post.username)}` }, `@${post.username}`),
      h('time', { datetime: post.createdAt, title: new Date(post.createdAt).toLocaleString() }, timeAgo(post.createdAt)),
    ),
    h('p', { class: 'post-body' }, highlight(post.body, searchTerm)),
    h('div', { class: 'post-actions' }, likeBtn, commentBtn, deleteBtn),
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

  container.replaceChildren(
    ...list.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'post-head' },
        h('a', { class: 'author', href: `#/u/${encodeURIComponent(c.username)}` }, `@${c.username}`),
        h('time', { datetime: c.createdAt, title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt)),
        c.canDelete && h('button', {
          class: 'link comment-delete',
          onclick: async () => {
            if (!confirm('Delete this comment?')) return;
            await api('DELETE', `/api/comments/${c.id}`);
            reload();
          },
        }, 'Delete'),
      ),
      h('p', { class: 'comment-body' }, c.body),
    )),
    ...(list.length ? [] : [h('p', { class: 'muted comment-status' }, 'No comments yet.')]),
    form,
    error,
  );
}

function renderPostList(container, posts, opts) {
  if (!posts.length) {
    container.replaceChildren(h('p', { class: 'empty' }, opts.emptyText));
    return;
  }
  container.replaceChildren(...posts.map((p) => renderPost(p, opts)));
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
  const list = h('div', {}, h('p', { class: 'empty' }, 'Loading…'));
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search posts from you and your friends…' });

  const load = async () => {
    const term = search.value.trim();
    const posts = await api('GET', `/api/feed${term ? `?q=${encodeURIComponent(term)}` : ''}`);
    renderPostList(list, posts, {
      searchTerm: term,
      onChange: load,
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
function friendActions(username, relation, onChange) {
  const act = (method, label, cls) => h('button', {
    class: cls,
    onclick: async (e) => {
      e.target.disabled = true;
      await api(method, `/api/friends/${encodeURIComponent(username)}`);
      await refreshMe();
      onChange();
    },
  }, label);

  switch (relation) {
    case 'friends': return [act('DELETE', 'Unfriend', 'danger')];
    case 'outgoing': return [act('DELETE', 'Cancel request', 'secondary')];
    case 'incoming': return [act('POST', 'Accept'), act('DELETE', 'Decline', 'secondary')];
    case 'none': return [act('POST', 'Add friend')];
    default: return [];
  }
}

async function renderProfile(username) {
  app.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  let profile;
  try {
    profile = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card empty' }, err.message));
    return;
  }
  const reload = () => renderProfile(username);
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
    renderPostList(list, profile.posts, {
      onChange: reload,
      emptyText: profile.relation === 'self' ? "You haven't posted yet." : `@${profile.username} hasn't posted yet.`,
    });
  } else {
    list.replaceChildren(h('p', { class: 'empty' }, `Become friends with @${profile.username} to see their posts.`));
  }
}

// ---------- Friends view ----------

async function renderFriends() {
  const reload = () => renderFriends();
  const [lists, users] = await Promise.all([api('GET', '/api/friends'), api('GET', '/api/users')]);

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
  const showPeople = (people) => {
    const others = people.filter((u) => u.relation === 'none');
    peopleList.replaceChildren(...(others.length
      ? others.map((u) => h('div', { class: 'user-row' },
          userLink(u.username),
          h('div', { class: 'actions' }, friendActions(u.username, u.relation, reload))))
      : [h('p', { class: 'muted', style: 'margin:0' }, 'No one else to add.')]));
  };
  const findInput = h('input', { type: 'search', placeholder: 'Find people by username…', style: 'margin-bottom:8px' });
  findInput.addEventListener('input', debounce(async () => {
    showPeople(await api('GET', `/api/users?q=${encodeURIComponent(findInput.value.trim())}`));
  }, 250));
  showPeople(users);

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
  if (profileMatch) return renderProfile(decodeURIComponent(profileMatch[1]));
  if (route === '/friends') return renderFriends();
  return renderHome();
}

window.addEventListener('hashchange', render);
refreshMe().then(render);
