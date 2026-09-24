// DOM helpers and the page's fixed elements.

export const app = document.getElementById('app');
export const nav = document.getElementById('nav');
const statusRegion = document.getElementById('status');
let idCounter = 0;

// Tiny DOM builder. Strings become text nodes, so user content is never parsed as HTML.
export function h(tag, props = {}, ...children) {
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

// A unique id, for linking elements (label `for`, aria-describedby, aria-controls).
export const newId = (prefix) => `${prefix}-${++idCounter}`;

// Read `text` out to screen reader users via the page's polite live region.
export function announce(text) {
  statusRegion.textContent = '';
  // Setting it in a later task makes screen readers announce it even if the text is unchanged.
  setTimeout(() => { statusRegion.textContent = text; }, 50);
}

export function setTitle(title) {
  document.title = title ? `${title} · Chirp` : 'Chirp';
}

// Move keyboard focus to `el`, making it focusable first if it isn't normally.
export function focusElement(el) {
  if (!el) return;
  if (!el.matches('a[href], button, input, textarea, select')) el.setAttribute('tabindex', '-1');
  el.focus();
}

// A loading or empty-state message. role="status" makes screen readers announce it politely.
export const statusMessage = (text) => h('p', { class: 'empty', role: 'status' }, text);
