// Post cards, comment threads, post lists and the compose box, used by the Home and Profile views.
import { app, h, newId, announce, focusElement, statusMessage } from '../dom.js';
import { api } from '../api.js';
import { CONFIG } from '../config.js';
import { IS_MAC, plural } from '../util.js';
import {
  runAction, confirmAction, asyncForm, appendLoadMore, lengthCounter, highlight, authorLine,
} from '../components.js';

// `onDeleted(card)` is called after the post was deleted, to take its card out of the list.
function renderPost(post, { searchTerm, onDeleted }) {
  const error = h('p', { class: 'error compact', role: 'alert' });

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
    onclick: () => confirmAction('Delete this post?', deleteBtn, error, async () => {
      await api('DELETE', `/api/posts/${post.id}`);
      onDeleted(card);
    }),
  }, 'Delete');

  const card = h('article', { class: 'card' },
    authorLine(post.username, post.createdAt),
    h('p', { class: 'user-text post-body' }, highlight(post.body, searchTerm)),
    h('div', { class: 'post-actions' }, likeBtn, commentBtn, deleteBtn),
    error,
    comments,
  );
  return card;
}

// Load and show the comment thread for `post` inside `container`, with a reply box.
// `onCountChange` is called whenever post.commentCount changes. `focusReply` puts focus in the
// reply box once it's shown.
async function renderComments(container, post, onCountChange, { focusReply = false } = {}) {
  container.replaceChildren(h('p', { class: 'muted comment-status', role: 'status' }, 'Loading comments…'));
  let list;
  try {
    list = await api('GET', `/api/posts/${post.id}/comments`);
  } catch (err) {
    container.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
    return;
  }
  const reload = (options) => renderComments(container, post, onCountChange, options);
  if (post.commentCount !== list.length) {
    post.commentCount = list.length;
    onCountChange();
  }

  const error = h('p', { class: 'error', role: 'alert', id: newId('error') });
  const input = h('input', { id: newId('comment'), placeholder: 'Write a comment…', autocomplete: 'off' });
  const { counter, update } = lengthCounter(input, CONFIG.maxCommentLength);
  input.setAttribute('aria-describedby', `${counter.id} ${error.id}`);
  input.addEventListener('input', () => {
    update();
    if (input.value.trim()) error.textContent = '';
  });
  const submit = h('button', { type: 'submit' }, 'Reply');
  const form = asyncForm({ class: 'comment-form' }, {
    submit,
    error,
    validate: () => {
      const { length, over } = update();
      if (length && !over) return true;
      error.textContent = length ? `Comments are limited to ${CONFIG.maxCommentLength} characters.` : 'Write a comment first.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return false;
    },
    onSubmit: async () => {
      await api('POST', `/api/posts/${post.id}/comments`, { body: input.value });
      announce('Comment added.');
      await reload({ focusReply: true });
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
      onclick: () => confirmAction('Delete this comment?', button, error, async () => {
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
      }),
    }, 'Delete');
    return button;
  };

  for (const c of list) {
    const item = h('li', { class: 'comment' });
    item.append(
      authorLine(c.username, c.createdAt, c.canDelete && deleteButton(c, item)),
      h('p', { class: 'user-text comment-body' }, c.body),
    );
    listEl.append(item);
  }

  container.replaceChildren(listEl, none, form, h('div', { class: 'comment-meta' }, counter), note, error);
  if (focusReply) input.focus();
}

// Show the first page of posts; `opts.fetchPage(cursor)` loads later pages ({ posts, nextCursor }).
export function renderPostList(container, { posts, nextCursor }, opts) {
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

// The "What's happening?" box. `onPosted()` is called after a post was created.
export function composeBox(onPosted) {
  // No maxlength: a long paste stays whole, and the counter says how far over the limit it is.
  const text = h('textarea', { id: newId('compose'), placeholder: "What's happening?" });
  const { counter, update } = lengthCounter(text, CONFIG.maxPostLength);
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

  const form = asyncForm({ class: 'card' }, {
    submit,
    error,
    validate: () => !submit.disabled, // Ctrl+Enter submits even while the button is disabled.
    onSubmit: async () => {
      await api('POST', '/api/posts', { body: text.value });
      text.value = '';
      announce('Posted.');
      onPosted();
    },
    onSettled: refresh, // runAction re-enables the button; disable it again if the box is empty.
  },
  h('label', { for: text.id, class: 'visually-hidden' }, 'Write a post'),
  text,
  h('div', { class: 'compose-footer' }, shortcut, counter, submit),
  error);
  return form;
}
