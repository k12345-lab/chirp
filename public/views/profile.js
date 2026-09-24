import { app, h, setTitle, focusElement, statusMessage } from '../dom.js';
import { api, apiUrl } from '../api.js';
import { RELATION } from '../config.js';
import { startView, focusView } from '../state.js';
import { showLoadError } from '../components.js';
import { renderPostList, composeBox } from './posts.js';
import { friendActions, blockButton } from './friend-actions.js';

// `joined` is "YYYY-MM" (or null if hidden). Built from parts, so it's the same month in every time zone.
function joinedText(joined) {
  if (!joined) return null;
  const [year, month] = joined.split('-').map(Number);
  return `Joined ${new Date(year, month - 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
}

// A user's profile: name, relation, friend actions and (for yourself and friends) their posts.
// `focusActions`: after a friend action, put focus back on the (new) action buttons.
export async function renderProfile(username, { focusActions = false } = {}) {
  const current = startView();
  setTitle(`@${username}`);
  const reload = (options) => renderProfile(username, options);
  const profileUrl = (cursor) => apiUrl(`/api/users/${encodeURIComponent(username)}`, { cursor });

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
    [RELATION.FRIENDS]: 'Friends',
    [RELATION.OUTGOING]: 'Friend request sent',
    [RELATION.INCOMING]: 'Wants to be your friend',
    [RELATION.DECLINED]: 'Declined your friend request',
    [RELATION.BLOCKED]: 'Blocked',
  }[profile.relation];
  const details = [joinedText(profile.joined), status].filter(Boolean).join(' · ');
  const isSelf = profile.relation === RELATION.SELF;
  const isBlocked = profile.relation === RELATION.BLOCKED;
  const afterAction = () => reload({ focusActions: true });

  const heading = h('h1', {}, `@${profile.username}`);
  const actions = h('div', { class: 'actions' },
    friendActions(profile.username, profile.relation, afterAction),
    !isSelf && !isBlocked && blockButton(profile.username, afterAction),
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
  } else if (isBlocked) {
    list.replaceChildren(statusMessage(`You’ve blocked @${profile.username}.`));
  } else {
    list.replaceChildren(statusMessage(`Become friends with @${profile.username} to see their posts.`));
  }

  if (focusActions) focusElement(actions.querySelector('button, a[href]') ?? heading);
  else focusView(heading);
}
