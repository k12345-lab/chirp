// Escape LIKE wildcards in user input; use with ESCAPE '\'.
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}
