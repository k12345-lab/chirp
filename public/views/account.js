import { app, h, newId, setTitle, focusElement, statusMessage } from '../dom.js';
import { api } from '../api.js';
import { RELATION } from '../config.js';
import { startView, focusView, loggedOut } from '../state.js';
import { confirmAction, asyncForm, showLoadError, userRow, privacyNotice } from '../components.js';
import { friendActions } from './friend-actions.js';

// Account & privacy: the privacy notice, data export, blocked people, sessions and account deletion.
export async function renderAccount() {
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
      userRow(name, friendActions(name, RELATION.BLOCKED, () => showBlocked(names.filter((n) => n !== name), i))));
    blockedSection.replaceChildren(title, names.length
      ? h('ul', { class: 'user-list' }, rows)
      : h('p', { class: 'muted flush' }, 'You haven’t blocked anyone. Use “Block” on a profile.'));
    if (focusIndex != null) focusElement(rows[Math.min(focusIndex, rows.length - 1)]?.querySelector('button') ?? title);
  };
  showBlocked(lists.blocked);

  const logoutAllError = h('p', { class: 'error compact', role: 'alert' });
  const logoutAll = h('button', {
    class: 'secondary',
    onclick: () => confirmAction('Log out of Chirp on every device, including this one?', logoutAll, logoutAllError,
      async () => {
        await api('POST', '/api/logout-all');
        loggedOut();
      }),
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
  const deleteForm = asyncForm({ class: 'account-delete' }, {
    submit: deleteBtn,
    error: deleteError,
    validate: () => confirm('Permanently delete your account, posts, comments, likes and friendships? This can’t be undone.'),
    onSubmit: async () => {
      try {
        await api('DELETE', '/api/me', { password: password.value });
      } catch (err) {
        if (err.status === 403) {
          password.setAttribute('aria-invalid', 'true');
          password.focus();
        }
        throw err;
      }
      loggedOut();
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
