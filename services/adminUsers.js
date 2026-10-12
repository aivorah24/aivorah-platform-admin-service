// Platform-admin user management: list, edit, block/unblock, password reset.
// Every write is audit-logged to analytics_events (event_type 'admin_action').
const { randomUUID } = require('crypto');
const supabase = require('./supabase');
const firebaseAdmin = require('./firebaseAdmin');
const { getAllowedAdminEmails } = require('../middleware/auth');
const { sendEmail } = require('./mailer');

const ROLES = ['student', 'teacher', 'parent', 'school_admin'];
const ROLE_LABEL = { student: 'Student', teacher: 'Teacher', parent: 'Parent', school_admin: 'School Admin' };
const PAGE_SIZE = 50;

class AdminUserError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function audit(adminEmail, action, target, meta = {}) {
  try {
    await supabase.from('analytics_events').insert({
      id: randomUUID(), event_type: 'admin_action', timestamp: new Date().toISOString(),
      user_email: adminEmail, role: 'platform_admin', source: 'platform-admin-service', page: action,
      meta: { action, targetId: target?.id || null, targetEmail: target?.email || null, ...meta },
    });
  } catch (err) {
    console.warn('[adminUsers] audit write failed:', err.message);
  }
}

// In-app notification straight into notifications (notify_event only targets students).
async function notifyUser(user, { title, body, actorEmail, version }) {
  try {
    await supabase.from('notifications').insert({
      recipient_id: user.id,
      recipient_role: user.role === 'school_admin' ? 'school_admin' : user.role,
      type: 'account_updated', entity_type: 'user', entity_id: user.id,
      title, body, data: {},
      event_key: `account_updated:user:${user.id}:${version}`,
      actor_email: actorEmail, actor_role: 'platform_admin',
    });
  } catch (err) {
    console.warn('[adminUsers] notification failed:', err.message);
  }
}

async function getUser(id) {
  const { data, error } = await supabase.from('users')
    .select('id, name, email, role, school, school_id, status, last_active_at, created_at').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new AdminUserError(404, 'User not found');
  return data;
}

// q matches name/email/school; role in ROLES; status 'active' | 'blocked'.
async function listUsers({ q = '', role = '', status = '', page = 1 } = {}) {
  let query = supabase.from('users')
    .select('id, name, email, role, school, school_id, status, last_active_at, created_at', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (role && ROLES.includes(role)) query = query.eq('role', role);
  if (status === 'blocked') query = query.eq('status', 'blocked');
  if (status === 'active') query = query.neq('status', 'blocked');
  const term = String(q).trim().replace(/[%,()]/g, ' ');
  if (term) query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,school.ilike.%${term}%`);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const { data, error, count } = await query.range((p - 1) * PAGE_SIZE, p * PAGE_SIZE - 1);
  if (error) throw error;
  const admins = getAllowedAdminEmails();
  return {
    users: (data || []).map((u) => ({ ...u, status: u.status === 'blocked' ? 'blocked' : 'active', isPlatformAdmin: admins.has(String(u.email).toLowerCase()) })),
    total: count || 0, page: p, pageSize: PAGE_SIZE,
  };
}

async function updateUser(id, { name, role, school }, adminEmail) {
  const user = await getUser(id);
  const patch = {};
  const changes = [];
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new AdminUserError(400, 'Name cannot be empty');
    if (trimmed !== user.name) { patch.name = trimmed; changes.push(['name', user.name, trimmed]); }
  }
  if (role !== undefined && role !== user.role) {
    if (!ROLES.includes(role)) throw new AdminUserError(400, `Role must be one of ${ROLES.join(', ')}`);
    if (getAllowedAdminEmails().has(String(user.email).toLowerCase())) throw new AdminUserError(403, "A platform admin's role can't be changed here");
    patch.role = role; changes.push(['role', user.role, role]);
  }
  if (school !== undefined && (school || null) !== (user.school || null)) {
    if (!school) {
      patch.school = null; patch.school_id = null;
    } else {
      const { data: sc } = await supabase.from('schools').select('id, name').eq('name', school).maybeSingle();
      if (!sc) throw new AdminUserError(400, `School "${school}" not found`);
      patch.school = sc.name; patch.school_id = sc.id;
    }
    changes.push(['school', user.school, patch.school]);
  }
  if (!changes.length) return { user, changed: [] };

  const { error } = await supabase.from('users').update(patch).eq('id', id);
  if (error) throw error;
  const updated = { ...user, ...patch };
  await audit(adminEmail, 'user.update', user, { changes: changes.map(([field, from, to]) => ({ field, from, to })) });

  const lines = changes.map(([field, , to]) => (field === 'role' ? `role is now ${ROLE_LABEL[to]}` : field === 'school' ? (to ? `school is now ${to}` : 'school was removed') : `name is now ${to}`));
  await notifyUser(updated, {
    title: 'Your account details were updated',
    body: `An Aivorah administrator updated your account: ${lines.join(', ')}.`,
    actorEmail: adminEmail,
    version: new Date().toISOString(),
  });
  return { user: updated, changed: changes.map(([f]) => f) };
}

async function firebaseUid(email) {
  if (!firebaseAdmin) throw new AdminUserError(500, 'Auth is not configured on this server');
  try { return (await firebaseAdmin.auth().getUserByEmail(email)).uid; } catch (err) {
    if (err.code === 'auth/user-not-found') return null;
    throw err;
  }
}

// blocked=true: sets users.status, disables the Firebase account and (optionally) revokes sessions.
async function setBlocked(ids, blocked, { reason, signOut = true } = {}, adminEmail) {
  const admins = getAllowedAdminEmails();
  const results = [];
  for (const id of ids) {
    try {
      const user = await getUser(id);
      const email = String(user.email || '').toLowerCase();
      if (blocked && email === String(adminEmail).toLowerCase()) throw new AdminUserError(403, "You can't block your own account");
      if (blocked && admins.has(email)) throw new AdminUserError(403, "Platform admins can't be blocked");

      const uid = await firebaseUid(user.email);
      if (uid) {
        await firebaseAdmin.auth().updateUser(uid, { disabled: blocked });
        if (blocked && signOut) await firebaseAdmin.auth().revokeRefreshTokens(uid);
      }
      const { error } = await supabase.from('users').update({ status: blocked ? 'blocked' : 'active' }).eq('id', id);
      if (error) throw error;
      await audit(adminEmail, blocked ? 'user.block' : 'user.unblock', user, blocked ? { reason: reason || null, signOut: !!signOut } : {});
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message, status: err.status || 500 });
    }
  }
  return results;
}

async function sendPasswordReset(id, adminEmail) {
  const user = await getUser(id);
  if (!firebaseAdmin) throw new AdminUserError(500, 'Auth is not configured on this server');
  const link = await firebaseAdmin.auth().generatePasswordResetLink(user.email);
  if (!process.env.RESEND_API_KEY && !(process.env.EMAIL_USER && process.env.EMAIL_PASS)) {
    throw new AdminUserError(503, 'Email sending is not configured on this server');
  }
  await sendEmail({
    to: user.email,
    subject: 'Reset your Aivorah password',
    html: `<p>Hi ${user.name || ''},</p><p>An Aivorah administrator sent you a link to set a new password:</p><p><a href="${link}">Reset password</a></p><p>If you didn't expect this, you can ignore this email.</p>`,
  });
  await audit(adminEmail, 'user.reset_password', user);
  return { sent: true };
}

module.exports = { listUsers, updateUser, setBlocked, sendPasswordReset, AdminUserError, ROLES, PAGE_SIZE };
