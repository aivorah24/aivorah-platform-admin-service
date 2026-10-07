// Access here is an EMAIL ALLOWLIST, not users.role — matching the monolith's
// routes/admin.js exactly (getAllowedAdminEmails/requireAdminAccess). The
// users table's 'role' column is NOT used as the gate: the existing admin
// accounts (e.g. the founder's own sign-in) are role:'student' there, so
// gating on role would lock out people who already have access today.
const firebaseAdmin = require('../services/firebaseAdmin');

function getAllowedAdminEmails() {
  const list = [
    'kannansaimohan2003@gmail.com',
    'preddy6678@gmail.com',
    process.env.ADMIN_EMAIL || '',
    ...(process.env.ADMIN_EMAILS || '').split(','),
  ];
  return new Set(list.map((e) => String(e).toLowerCase().trim()).filter(Boolean));
}

async function requireAdmin(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Sign in required' });
  if (!firebaseAdmin) return res.status(500).json({ error: 'Auth is not configured on this server' });

  let decoded;
  try {
    decoded = await firebaseAdmin.auth().verifyIdToken(match[1]);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired sign-in' });
  }
  const email = String(decoded.email || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Sign-in has no email' });

  if (!getAllowedAdminEmails().has(email)) {
    return res.status(403).json({ error: 'This account does not have platform admin access' });
  }
  req.adminEmail = email;
  next();
}

module.exports = { requireAdmin, getAllowedAdminEmails };
