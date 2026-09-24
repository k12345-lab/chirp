// Talking to the server. api() only reports failures; what a 401 means for the page (the session
// has ended, so show the login form) is decided by the router, which registers onUnauthorized.

let unauthorizedHandler = () => {};

// Call `handler` whenever a request gets 401 Not logged in (including a failed login).
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

// Errors thrown here carry the HTTP `status` (0 if the server couldn't be reached).
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Couldn't reach Chirp. Check your connection."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) unauthorizedHandler();
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// `path` plus a query string made of the non-empty `params`.
export function apiUrl(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return query ? `${path}?${query}` : path;
}
