// CSRF defence in depth (on top of SameSite=Strict). Browsers send Origin on cross-site requests
// and on same-origin POST/DELETE, so a data-changing /api request from another site is refused.
// Requests with neither Origin nor Sec-Fetch-Site come from non-browser clients such as curl,
// which can't ride on a victim's cookies, so they're allowed.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null; // e.g. "null" from a sandboxed frame.
  }
}

export function sameOriginOnly(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const sameOrigin = origin
    ? hostOf(origin) === String(req.get('host') ?? '').toLowerCase()
    : !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  if (!sameOrigin) return res.status(403).json({ error: 'Cross-origin request refused' });
  next();
}
