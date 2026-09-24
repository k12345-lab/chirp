# Chirp

A tiny Twitter-like app for a small group of friends.

- Sign up / log in with a username and password
- Post short messages (280 characters max)
- Send, accept, and decline friend requests; block people
- Home feed shows your posts and your friends' posts, newest first
- Search bar filters the feed by post text or username
- Like posts, delete your own posts, and view profile pages
- Comment on posts you can see (yours and your friends'); delete your own comments, or any comment on your own posts
- Download your data, log out on every device, or delete your account (Account & privacy, linked from your profile)
- Accessible UI: labelled fields, keyboard focus management, screen reader announcements, WCAG AA contrast in light and dark mode, and a layout that works down to 360px wide

## Running it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module, so no database server is needed).

```
npm install
npm start
```

Then open http://localhost:3000. Use `npm run dev` to auto-restart on code changes.

The database is a single file at `data/chirp.db`, created automatically on first run. Delete it to start fresh.

## Configuration

| Variable        | Default          | Purpose                                    |
|-----------------|------------------|--------------------------------------------|
| `PORT`          | `3000`           | Port to listen on                          |
| `DB_PATH`       | `data/chirp.db`  | Location of the SQLite database file (its folder is created if missing) |
| `COOKIE_SECURE` | `true`           | Set to `false` only to test over plain HTTP on a host other than localhost (e.g. another device on your LAN). Never in production. |
| `TRUST_PROXY`   | —                | Set when running behind a reverse proxy (e.g. `1` for one proxy hop, or `loopback`) so client IPs (for rate limits) and HTTPS are detected correctly. Passed to Express's `trust proxy` setting. |

In production, serve Chirp over HTTPS. If you put it behind a reverse proxy, the proxy must pass the original `Host` header through (for nginx, `proxy_set_header Host $host;`), because the session cookie and the cross-origin check both depend on it.

## Project layout

```
server.js            Express server: auth, posts, likes, friends API
db.js                SQLite connection and schema
common-passwords.js  Short list of common passwords refused at signup
public/              Frontend (plain HTML/CSS/JS, hash-based routing)
```

## How it works

- **Passwords** are hashed with scrypt (N=2^17, r=8, p=1) and a random salt per user, off the main thread. The parameters are stored with each hash, and older hashes are upgraded the next time that user logs in. Signup refuses passwords shorter than 8 characters, equal to the username, or on a short list of common passwords.
- **Sessions** are random tokens sent as an `HttpOnly`, `SameSite=Strict` cookie. The database only stores their SHA-256 hash. A session expires after 14 days without use, and 90 days after login in any case. `POST /api/logout-all` ends all of your sessions on every device. Expired sessions are deleted hourly.
- **Friendships** are one row per pair of users. The row is `pending` until the other person accepts it, and then it becomes `accepted`. Canceling or unfriending deletes the row. Declining marks it `declined`: the requester's profile view shows "Declined your friend request" and they can't ask again for 30 days (the person who declined can still send a request). Blocking replaces the row with a `blocked` one (see Privacy below).
- **Privacy:** you can only see, search, like, and comment on posts from yourself and your accepted friends. A comment is shown to its author, the post's author, and the commenter's accepted friends, so people who aren't friends with the commenter never see it (different readers of the same post can see different comments).
- **Friend actions state their intent.** `POST /api/friends/:username` takes `{ "intent": "request" | "accept" }` and `DELETE` takes an optional `{ "intent": "cancel" | "decline" | "unfriend" }`. A request that no longer matches the relationship (for example, accepting a request that was already canceled) gets `409` and changes nothing. A new request returns `201`, an accepted one `200`, and removing a friendship that doesn't exist returns `404`. `POST /api/blocks/:username` blocks someone and `DELETE /api/blocks/:username` unblocks them.
- **Lists are paginated.** The feed, profile posts, and `/api/users` return one page at a time plus a `nextCursor`. Pass it back as `?cursor=` to get the next page, and the UI shows a "Load more" button. `/api/users` matches usernames by prefix, 10 per page; `?relation=none` (people you could still add) filters in SQL. A search that can return strangers needs at least 3 characters.
- **Your account.** `GET /api/me/export` downloads your data as JSON (account, posts, your comments, likes, friendships). `DELETE /api/me` with `{ "password": "..." }` deletes your account; the database's `ON DELETE CASCADE` removes your sessions, posts (with the likes and comments on them), comments, likes and friendships.

## Security notes

- **Session cookie.** Normally the cookie is `__Host-sid`, marked `Secure`, so browsers only send it over HTTPS and subdomains can't overwrite it. The one exception is local development: plain-HTTP requests to `localhost`, `127.0.0.1` or `[::1]` get an ordinary `sid` cookie without `Secure`, so `http://localhost:3000` works in every browser. If you open the app on another host over plain HTTP (e.g. `http://192.168.1.5:3000`), logging in won't stick unless you set `COOKIE_SECURE=false`. Upgrading from an older version logs everyone out once, because the old raw-token sessions are dropped.
- **Rate limits** (per server process, in memory, reset on restart). Hitting one returns `429` with a JSON error.

  | Action                    | Limit                                   |
  |---------------------------|-----------------------------------------|
  | Failed logins per account | 10 per 15 minutes                       |
  | Failed logins per IP      | 30 per 15 minutes                       |
  | Sign-ups per IP           | 10 per hour                             |
  | Posts per user            | 30 per 15 minutes                       |
  | Comments per user         | 60 per 15 minutes                       |
  | Friend requests/accepts   | 50 per hour per user                    |
  | Blocks                    | 50 per hour per user                    |
  | User searches             | 120 per 15 minutes per user             |
  | Lookups of unknown users  | 60 per 15 minutes per user (only `404`s count) |
  | Failed account deletions  | 5 per 15 minutes per user               |
  | Data exports              | 10 per hour per user                    |

  The per-account login limit means someone who knows your username can lock you out of logging in for up to 15 minutes. Sessions that are already logged in keep working.
- **Headers.** [Helmet](https://helmetjs.github.io/) sets a strict Content-Security-Policy (`default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`), HSTS (one year, which browsers only honour over HTTPS), `X-Frame-Options: DENY`, `nosniff` and others, and `X-Powered-By` is not sent. The CSP forbids inline scripts and inline `style` attributes, so the frontend sets styles through `element.style` instead.
- **CSRF.** Besides `SameSite=Strict`, every `/api` request that changes data (anything but `GET`/`HEAD`/`OPTIONS`) is refused with `403` if its `Origin` header names another host, or `Sec-Fetch-Site` says it's cross-site. Requests with neither header (e.g. `curl`) are allowed, since they can't carry a browser's cookies.
- **Input limits.** Route ids must be positive integers (otherwise `400`), searches (`q`) are limited to 100 characters, and JSON bodies to 10 KB. Every error, including malformed JSON, is returned as JSON `{ "error": "..." }` without a stack trace.

## Privacy and retention

- **What's stored:** your username, a scrypt hash of your password, when you joined, your posts, comments and likes, your friendships, requests and blocks, and hashes of your session tokens. No email address, IP addresses or analytics, nothing is logged about you, and the page loads nothing from third parties.
- **Who sees what:** your posts are visible only to you and your accepted friends. Your comments are visible to the post's author and to your own friends who can see the post. People who aren't your friends see only your username, not when you joined; friends see the month you joined. Someone you block can't see your profile, find you in searches or send you requests.
- **How long it's kept:** everything stays until you delete it. Deleting a post removes its likes and comments. Sessions are deleted when you log out or when they expire (14 days unused, 90 days at most). Deleting your account (Account & privacy, password required) removes everything above at once. Download your data first if you want a copy.
- **Deleted means deleted:** the database runs with `PRAGMA secure_delete = ON`, so deleted rows are overwritten in the file, and the write-ahead log is checkpointed and truncated hourly and after an account deletion. Backups you make yourself keep whatever was in the file when they were taken.
- **Usernames aren't secret.** Signing up with a taken name says so, and anyone logged in can look up an exact username or search by a 3-character prefix. Those endpoints are rate-limited (see above) so the list of users can't be pulled quickly, and failed logins take the same time whether or not the username exists.
