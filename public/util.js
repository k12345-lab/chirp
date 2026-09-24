// Small helpers that don't touch the DOM.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// For repeated requests (e.g. search-as-you-type): each call returns an `isLatest` check that
// stays true only until the next call, so older responses never replace newer ones.
export function latestOnly() {
  let counter = 0;
  return () => {
    const id = ++counter;
    return () => id === counter;
  };
}

// Short relative time for the last week ("just now", "5m", "3h", "2d"), then the date
// (with the year only when it isn't this year).
export function timeAgo(iso) {
  const date = new Date(iso);
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: thisYear ? undefined : 'numeric' });
}

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
