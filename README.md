# Chirp

A tiny Twitter-like app for a small group of friends.

- Sign up / log in with a username and password
- Post short messages (280 characters max)
- Send, accept, and decline friend requests
- Home feed shows your posts and your friends' posts, newest first
- Search bar filters the feed by post text or username
- Like posts, delete your own posts, and view profile pages
- Comment on posts you can see (yours and your friends'); delete your own comments, or any comment on your own posts

## Running it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module, so no database server is needed).

```
npm install
npm start
```

Then open http://localhost:3000. Use `npm run dev` to auto-restart on code changes.

The database is a single file at `data/chirp.db`, created automatically on first run. Delete it to start fresh.

## Configuration

| Variable    | Default          | Purpose                                    |
|-------------|------------------|--------------------------------------------|
| `PORT`      | `3000`           | Port to listen on                          |
| `DB_PATH`   | `data/chirp.db`  | Location of the SQLite database file (its folder is created if missing) |
| `NODE_ENV`  | —                | Set to `production` when served over HTTPS so the session cookie is marked `Secure` |

## Project layout

```
server.js        Express server: auth, posts, likes, friends API
db.js            SQLite connection and schema
public/          Frontend (plain HTML/CSS/JS, hash-based routing)
```

## How it works

- **Passwords** are hashed with scrypt and a random salt per user.
- **Sessions** are random tokens stored in the `sessions` table and sent as an `HttpOnly`, `SameSite=Strict` cookie. They last 30 days.
- **Friendships** are one row per pair of users. The row is `pending` until the other person accepts it, and then it becomes `accepted`. Declining, canceling, or unfriending deletes the row.
- **Privacy:** you can only see, search, like, and comment on posts from yourself and your accepted friends.
- **Friend actions state their intent.** `POST /api/friends/:username` takes `{ "intent": "request" | "accept" }` and `DELETE` takes an optional `{ "intent": "cancel" | "decline" | "unfriend" }`. A request that no longer matches the relationship (for example, accepting a request that was already canceled) gets `409` and changes nothing. A new request returns `201`, an accepted one `200`, and removing a friendship that doesn't exist returns `404`.
- **Lists are paginated.** The feed, profile posts, and `/api/users` return one page at a time plus a `nextCursor`. Pass it back as `?cursor=` to get the next page, and the UI shows a "Load more" button. `/api/users?relation=none` filters in SQL, so "Find people" lists everyone you could still add.
