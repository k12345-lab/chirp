// Limits, names and time units shared across the server. The ones the frontend needs are also
// served to it by GET /api/config (see CLIENT_CONFIG), so they're defined only here.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const MAX_POST_LENGTH = 280;
export const MAX_COMMENT_LENGTH = 280;
export const MAX_SEARCH_LENGTH = 100;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 20;
// Without anchors, so the frontend can use it as an <input pattern> (which is implicitly anchored).
export const USERNAME_PATTERN = `[a-zA-Z0-9_]{${MIN_USERNAME_LENGTH},${MAX_USERNAME_LENGTH}}`;
export const USERNAME_RE = new RegExp(`^${USERNAME_PATTERN}$`);
export const JSON_BODY_LIMIT = '10kb';
export const POSTS_PAGE_SIZE = 50;
export const USERS_PAGE_SIZE = 10;
// Searches that can list strangers must give at least this many leading characters of a username.
export const MIN_USER_SEARCH_LENGTH = 3;
// After someone declines your friend request, you can't ask them again for this long.
export const DECLINE_COOLDOWN_DAYS = 30;
export const DECLINE_COOLDOWN_MS = DECLINE_COOLDOWN_DAYS * DAY;

// One row per pair of users in `friendships`, keyed by who acted first:
// - 'pending':  requester asked addressee; 'accepted' once the addressee agrees.
// - 'declined': the addressee said no. The requester can't ask again until DECLINE_COOLDOWN_MS has
//   passed (counted from responded_at); the addressee may still ask them.
// - 'blocked':  requester blocked addressee. The blocked user can't see or contact the blocker.
export const FRIENDSHIP_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  BLOCKED: 'blocked',
});

// How the current user relates to another user; see queries/friends.js. Sent to the client as
// `relation`.
export const RELATION = Object.freeze({
  SELF: 'self',
  FRIENDS: 'friends',
  OUTGOING: 'outgoing', // You asked them.
  INCOMING: 'incoming', // They asked you.
  DECLINED: 'declined', // They declined your request recently.
  BLOCKED: 'blocked', // You blocked them.
  BLOCKED_BY: 'blocked-by', // They blocked you. Never sent to the client.
  NONE: 'none',
});

// Limits and names the frontend shares with the server. BLOCKED_BY is left out: the client never
// sees it.
const { BLOCKED_BY, ...CLIENT_RELATION } = RELATION;
export const CLIENT_CONFIG = Object.freeze({
  maxPostLength: MAX_POST_LENGTH,
  maxCommentLength: MAX_COMMENT_LENGTH,
  maxSearchLength: MAX_SEARCH_LENGTH,
  minUserSearchLength: MIN_USER_SEARCH_LENGTH,
  minUsernameLength: MIN_USERNAME_LENGTH,
  maxUsernameLength: MAX_USERNAME_LENGTH,
  usernamePattern: USERNAME_PATTERN,
  minPasswordLength: MIN_PASSWORD_LENGTH,
  maxPasswordLength: MAX_PASSWORD_LENGTH,
  declineCooldownDays: DECLINE_COOLDOWN_DAYS,
  relation: CLIENT_RELATION,
});
