import { api } from './api.js';

// Limits and names shared with the server, which enforces them, loaded from GET /api/config at
// startup (see loadConfig): maxPostLength, maxCommentLength, maxSearchLength, minUserSearchLength,
// min/maxUsernameLength, usernamePattern, min/maxPasswordLength and declineCooldownDays.
export const CONFIG = {};
// How the current user relates to another user (e.g. RELATION.FRIENDS is 'friends'), as the
// server sends it in `relation`. Also loaded from /api/config.
export const RELATION = {};

// Fetch the limits and names shared with the server (once).
export async function loadConfig() {
  if (RELATION.NONE) return;
  const { relation, ...config } = await api('GET', '/api/config');
  Object.assign(CONFIG, config);
  Object.assign(RELATION, relation);
}
