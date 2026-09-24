import { app, h, announce, setTitle, statusMessage } from '../dom.js';
import { api, apiUrl } from '../api.js';
import { CONFIG } from '../config.js';
import { startView, focusView } from '../state.js';
import { debounce, latestOnly } from '../util.js';
import { showLoadError, searchForm } from '../components.js';
import { renderPostList, composeBox } from './posts.js';

// The home feed: a compose box, a search box, and posts from you and your friends.
export function renderHome() {
  const current = startView();
  setTitle('Home');
  const heading = h('h1', { class: 'view-title' }, 'Home');
  const list = h('div', {}, statusMessage('Loading…'));
  const search = h('input', { type: 'search', maxlength: CONFIG.maxSearchLength, placeholder: 'Search posts from you and your friends…' });
  const nextRequest = latestOnly();
  const feedUrl = (term, cursor) => apiUrl('/api/feed', { q: term, cursor });

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
