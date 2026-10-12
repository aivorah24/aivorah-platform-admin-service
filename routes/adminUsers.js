const express = require('express');
const router = express.Router();
const { listUsers, updateUser, setBlocked, sendPasswordReset } = require('../services/adminUsers');

const MAX_BULK = 200;

function fail(res, err) {
  if (!err.status) console.error('[admin/users]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Request failed' });
}

const idList = (body) => (Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : []);

// GET /admin/users?q=&role=&status=active|blocked&page=
router.get('/', async (req, res) => {
  try { res.json(await listUsers(req.query)); } catch (err) { fail(res, err); }
});

// PATCH /admin/users/:id { name?, role?, school? } — email changes go through the user's Change Email flow.
router.patch('/:id', async (req, res) => {
  try { res.json(await updateUser(req.params.id, req.body || {}, req.adminEmail)); } catch (err) { fail(res, err); }
});

// POST /admin/users/:id/block { reason?, signOut? } and /unblock
router.post('/:id/block', async (req, res) => {
  try {
    const [r] = await setBlocked([req.params.id], true, req.body || {}, req.adminEmail);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) { fail(res, err); }
});

router.post('/:id/unblock', async (req, res) => {
  try {
    const [r] = await setBlocked([req.params.id], false, {}, req.adminEmail);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) { fail(res, err); }
});

// POST /admin/users/bulk-block { ids, reason?, signOut? } and /bulk-unblock { ids } — per-id results.
router.post('/bulk-block', async (req, res) => {
  const ids = idList(req.body);
  if (!ids.length || ids.length > MAX_BULK) return res.status(400).json({ error: `ids must have 1-${MAX_BULK} entries` });
  try { res.json({ results: await setBlocked(ids, true, req.body, req.adminEmail) }); } catch (err) { fail(res, err); }
});

router.post('/bulk-unblock', async (req, res) => {
  const ids = idList(req.body);
  if (!ids.length || ids.length > MAX_BULK) return res.status(400).json({ error: `ids must have 1-${MAX_BULK} entries` });
  try { res.json({ results: await setBlocked(ids, false, {}, req.adminEmail) }); } catch (err) { fail(res, err); }
});

// POST /admin/users/:id/reset-password — emails a Firebase password-reset link.
router.post('/:id/reset-password', async (req, res) => {
  try { res.json(await sendPasswordReset(req.params.id, req.adminEmail)); } catch (err) { fail(res, err); }
});

module.exports = router;
