// Friend requests, friendships and blocks.
import express from 'express';
import { FRIENDSHIP_STATUS as STATUS, RELATION } from '../config.js';
import { requireAuth } from '../auth.js';
import {
  deleteFriendship, listFriendships, replaceFriendship, respondToRequest, unblock,
} from '../queries/friends.js';
import { blockLimiter, friendLimiter } from '../middleware/rate-limits.js';
import { requireIntent } from '../middleware/validate.js';
import { loadVisibleUser } from '../middleware/loaders.js';

const router = express.Router();

// Your friends, requests in both directions, and the people you've blocked. Requests you declined
// and requests of yours that were declined are left out (a profile shows the latter).
router.get('/friends', requireAuth, (req, res) => {
  res.json(listFriendships(req.user.id));
});

// Body: { intent: 'request' | 'accept' }.
// - request: 201 if a new request was created; 200 if they had already asked you (it's accepted);
//   409 if you're already friends, already asked them, they declined you within the cooldown,
//   or you blocked them.
// - accept: 200 if their pending request was accepted; 409 if there is no request to accept
//   (e.g. they canceled it), so a stale "Accept" button never sends a new request.
// 404 if the user doesn't exist or has blocked you.
router.post('/friends/:username', requireAuth, friendLimiter, requireIntent(['request', 'accept']), loadVisibleUser,
  (req, res) => {
    const { user: other, relationship } = req.other;
    if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't friend yourself" });

    if (relationship === RELATION.INCOMING) {
      respondToRequest(other.id, req.user.id, STATUS.ACCEPTED);
      return res.json({ relation: RELATION.FRIENDS, result: 'accepted' });
    }
    if (req.intent === 'accept') {
      return res.status(409).json({ error: `@${other.username} has no pending request to accept`, relation: relationship });
    }
    if (relationship === RELATION.NONE) {
      // Replaces any old declined request between you (in either direction).
      replaceFriendship(req.user.id, other.id, STATUS.PENDING);
      return res.status(201).json({ relation: RELATION.OUTGOING, result: 'created' });
    }
    const error = {
      [RELATION.FRIENDS]: `You're already friends with @${other.username}`,
      [RELATION.OUTGOING]: 'Friend request already sent',
      [RELATION.DECLINED]: `@${other.username} declined your friend request. You can't send another one yet.`,
      [RELATION.BLOCKED]: `You've blocked @${other.username}. Unblock them first.`,
    }[relationship];
    res.status(409).json({ error, relation: relationship });
  });

// Cancel your request, decline theirs, or unfriend. Optional body
// { intent: 'cancel' | 'decline' | 'unfriend' } makes the request fail with 409 unless the relation
// still matches (so a stale "Cancel request" button can't unfriend someone who has since accepted).
// Declining keeps the row as 'declined', so the requester can't ask again straight away; the other
// two delete it. 404 if there was nothing to remove. Blocks are removed with DELETE /api/blocks.
const DELETE_INTENTS = { cancel: RELATION.OUTGOING, decline: RELATION.INCOMING, unfriend: RELATION.FRIENDS };
router.delete('/friends/:username', requireAuth, requireIntent(Object.keys(DELETE_INTENTS), { optional: true }),
  loadVisibleUser, (req, res) => {
    const { user: other, relationship } = req.other;
    if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't unfriend yourself" });
    if (relationship === RELATION.NONE || relationship === RELATION.DECLINED) {
      return res.status(404).json({ error: 'No friendship or request to remove', relation: relationship });
    }
    if (relationship === RELATION.BLOCKED || (req.intent && DELETE_INTENTS[req.intent] !== relationship)) {
      return res.status(409).json({ error: 'That friendship has changed. Refresh and try again.', relation: relationship });
    }
    if (relationship === RELATION.INCOMING) {
      respondToRequest(other.id, req.user.id, STATUS.DECLINED);
      return res.json({ relation: RELATION.NONE, result: 'declined' });
    }
    deleteFriendship(req.user.id, other.id);
    res.json({ relation: RELATION.NONE, result: 'removed' });
  });

// Block a user: ends any friendship or request between you, and from then on they can't see your
// profile, find you in searches or send you requests (to them it looks like you don't exist).
// 201 when blocked, 200 if you had already blocked them.
router.post('/blocks/:username', requireAuth, blockLimiter, loadVisibleUser, (req, res) => {
  const { user: other, relationship } = req.other;
  if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't block yourself" });
  if (relationship === RELATION.BLOCKED) return res.json({ relation: RELATION.BLOCKED, result: 'unchanged' });
  replaceFriendship(req.user.id, other.id, STATUS.BLOCKED);
  res.status(201).json({ relation: RELATION.BLOCKED, result: 'blocked' });
});

// Unblock a user. 404 if you hadn't blocked them.
router.delete('/blocks/:username', requireAuth, loadVisibleUser, (req, res) => {
  const { user: other, relationship } = req.other;
  if (!unblock(req.user.id, other.id)) {
    return res.status(404).json({ error: `You haven't blocked @${other.username}`, relation: relationship });
  }
  res.json({ relation: RELATION.NONE, result: 'unblocked' });
});

export default router;
