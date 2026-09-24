import { app, h, setTitle, focusElement, statusMessage } from '../dom.js';
import { api, apiUrl } from '../api.js';
import { CONFIG, RELATION } from '../config.js';
import { startView, focusView } from '../state.js';
import { debounce, latestOnly } from '../util.js';
import { showLoadError, appendLoadMore, userRow, searchForm } from '../components.js';
import { friendActions } from './friend-actions.js';

// "Find people" only lists users you have no friendship or request with (filtered by the server).
const peopleUrl = (q, cursor) => apiUrl('/api/users', { relation: RELATION.NONE, q, cursor });

// Your friend requests, friends and sent requests, plus a search for people to add.
export function renderFriends() {
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
      data.incoming.length ? section('incoming', 'Friend requests', data.incoming, RELATION.INCOMING, '') : '',
      section('friends', 'Friends', data.friends, RELATION.FRIENDS, 'No friends yet — find people below.'),
      data.outgoing.length ? section('outgoing', 'Sent requests', data.outgoing, RELATION.OUTGOING, '') : '',
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

  const findInput = h('input', { type: 'search', maxlength: CONFIG.maxSearchLength, placeholder: 'Find people by username…', autocomplete: 'off' });
  const searchHint = () => {
    peopleList.replaceChildren();
    setFindStatus(`Type the first ${CONFIG.minUserSearchLength} or more letters of their username.`);
  };
  const nextSearch = latestOnly();
  const find = async () => {
    const isLatest = nextSearch();
    const q = findInput.value.trim();
    if (q.length < CONFIG.minUserSearchLength) return searchHint();
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
