// Buttons for changing a friendship, used by the Profile, Friends and Account views.
import { h, announce } from '../dom.js';
import { api } from '../api.js';
import { CONFIG, RELATION } from '../config.js';
import { refreshBadge } from '../state.js';
import { plural } from '../util.js';
import { confirmAction } from '../components.js';

// Buttons for managing the friendship with `username`, based on the current relation.
// Each button sends its intent, so a stale button (e.g. "Accept" after they canceled their
// request) fails with an error instead of doing something else. After a change, the result
// is announced and `onChange(newRelation)` is called.
export function friendActions(username, relation, onChange) {
  const error = h('span', { class: 'error compact', role: 'alert' });
  const name = encodeURIComponent(username);
  const act = (method, url, intent, label, { cls, confirmText, done }) => {
    const button = h('button', {
      class: cls,
      // Rows of identical buttons need to say whom they're for.
      'aria-label': `${label} @${username}`,
      onclick: () => confirmAction(confirmText, button, error, async () => {
        let result;
        try {
          result = await api(method, url, intent ? { intent } : undefined);
        } finally {
          refreshBadge();
        }
        announce(result.relation === RELATION.FRIENDS ? `You’re now friends with @${username}.` : done);
        onChange(result.relation);
      }),
    }, label);
    return button;
  };
  const friends = `/api/friends/${name}`;

  switch (relation) {
    case RELATION.FRIENDS: return [act('DELETE', friends, 'unfriend', 'Unfriend', {
      cls: 'danger',
      confirmText: `Unfriend @${username}? You’ll no longer see each other’s posts.`,
      done: `Unfriended @${username}.`,
    }), error];
    case RELATION.OUTGOING: return [act('DELETE', friends, 'cancel', 'Cancel request', {
      cls: 'secondary',
      done: `Canceled your friend request to @${username}.`,
    }), error];
    case RELATION.INCOMING: return [
      act('POST', friends, 'accept', 'Accept', {}),
      act('DELETE', friends, 'decline', 'Decline', {
        cls: 'secondary',
        confirmText: `Decline @${username}’s friend request? They won’t be able to ask again for ${plural(CONFIG.declineCooldownDays, 'day')}.`,
        done: `Declined @${username}’s friend request.`,
      }),
      error,
    ];
    case RELATION.NONE: return [act('POST', friends, 'request', 'Add friend', { done: `Friend request sent to @${username}.` }), error];
    case RELATION.BLOCKED: return [act('DELETE', `/api/blocks/${name}`, null, 'Unblock', {
      cls: 'secondary',
      done: `Unblocked @${username}.`,
    }), error];
    default: return [];
  }
}

// "Block" button for a profile. Blocking ends any friendship or request, and hides you from them.
export function blockButton(username, onChange) {
  const button = h('button', {
    class: 'danger',
    'aria-label': `Block @${username}`,
    onclick: () => confirmAction(
      `Block @${username}? This ends any friendship or request between you, and they won’t be able to see your profile, find you or send you requests.`,
      button, null, async () => {
        await api('POST', `/api/blocks/${encodeURIComponent(username)}`);
        announce(`Blocked @${username}.`);
        refreshBadge();
        onChange();
      }),
  }, 'Block');
  return button;
}
