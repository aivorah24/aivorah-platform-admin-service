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
const SUPPORT_EMAIL = 'aivorah24@gmail.com';
const CURRICULA = ['IB PYP', 'IB MYP', 'IB DP', 'CBSE', 'ICSE', 'Cambridge'];
const GRADE_RE = /^Grade (1[0-2]|[1-9])$/;

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
  if (user.role === 'parent') return; // parent notifications must reference a child (notifications_parent_has_child)
  try {
    const { error } = await supabase.from('notifications').insert({
      recipient_id: user.id,
      recipient_role: user.role === 'school_admin' ? 'school_admin' : user.role,
      type: 'account_updated', entity_type: 'user', entity_id: user.id,
      title, body, data: {},
      event_key: `account_updated:user:${user.id}:${version}`,
      actor_email: actorEmail, actor_role: 'platform_admin',
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[adminUsers] notification failed:', err.message);
  }
}

async function getUser(id) {
  const { data, error } = await supabase.from('users')
    .select('id, name, email, role, school, school_id, curriculum, grade, section, status, last_active_at, created_at').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new AdminUserError(404, 'User not found');
  return data;
}

// q matches name/email/school; role in ROLES; status 'active' | 'blocked'.
async function listUsers({ q = '', role = '', status = '', page = 1 } = {}) {
  let query = supabase.from('users')
    .select('id, name, email, role, school, school_id, curriculum, grade, section, status, last_active_at, created_at', { count: 'exact' })
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

async function updateUser(id, { name, role, school, curriculum, grade, section }, adminEmail) {
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
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  if (curriculum !== undefined && clean(curriculum) !== (user.curriculum || null)) {
    const c = clean(curriculum);
    if (c && !CURRICULA.includes(c)) throw new AdminUserError(400, `Curriculum must be one of ${CURRICULA.join(', ')}`);
    patch.curriculum = c; changes.push(['curriculum', user.curriculum, c]);
  }
  if (grade !== undefined && clean(grade) !== (user.grade || null)) {
    const g = clean(grade);
    if (g && !GRADE_RE.test(g)) throw new AdminUserError(400, 'Grade must look like "Grade 3"');
    patch.grade = g; changes.push(['grade', user.grade, g]);
  }
  if (section !== undefined && clean(section) !== (user.section || null)) {
    const sec = clean(section);
    if (sec && sec.length > 20) throw new AdminUserError(400, 'Section is too long');
    patch.section = sec; changes.push(['section', user.section, sec]);
  }
  const next = { ...user, ...patch };
  if (patch.role === 'student' && (!next.curriculum || !next.grade)) {
    throw new AdminUserError(400, 'A student needs a curriculum and grade');
  }
  if (!changes.length) return { user, changed: [] };

  const { error } = await supabase.from('users').update(patch).eq('id', id);
  if (error) throw error;
  const updated = { ...user, ...patch };
  await audit(adminEmail, 'user.update', user, { changes: changes.map(([field, from, to]) => ({ field, from, to })) });

  const lines = changes.map(([field, , to]) => (to ? `${field}: ${field === 'role' ? ROLE_LABEL[to] : to}` : `${field} removed`));
  const roleChanged = changes.some(([f]) => f === 'role');
  await notifyUser(updated, {
    title: roleChanged ? `Your role has been updated to ${ROLE_LABEL[updated.role]}` : 'Your account details have been updated',
    body: `As per your request, an Aivorah administrator has updated your account (${lines.join('; ')}). Please contact ${SUPPORT_EMAIL} if anything looks incorrect.`,
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

      // DB first so a rejected write never leaves Firebase disabled; revert the row if Firebase fails.
      const prevStatus = user.status || 'active';
      const { error } = await supabase.from('users').update({ status: blocked ? 'blocked' : 'active' }).eq('id', id);
      if (error) throw error;
      try {
        const uid = await firebaseUid(user.email);
        if (uid) {
          await firebaseAdmin.auth().updateUser(uid, { disabled: blocked });
          if (blocked && signOut) await firebaseAdmin.auth().revokeRefreshTokens(uid);
        }
      } catch (err) {
        await supabase.from('users').update({ status: prevStatus }).eq('id', id);
        throw err;
      }
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'https://aivorah-auth-service-g27s.onrender.com';
const APP_URL = process.env.APP_URL || 'https://aivorah.ai';
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;

function inviteHtml({ name, roleLabel, link }) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0B0B0B">
  <h2 style="margin:0 0 12px">Welcome to Aivorah</h2>
  <p>Hi ${esc(name)},</p>
  <p>An Aivorah administrator has created a <strong>${roleLabel}</strong> account for you. To get started, set your password using the button below.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#9A7B2E;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Set your password</a></p>
  <p>After signing in, you'll be asked to verify your email address — we've sent a separate verification email for this.</p>
  <p style="color:#70706B;font-size:12px;margin-top:28px">If you weren't expecting this invitation, please contact ${SUPPORT_EMAIL}.</p>
</div>`;
}

// Creates a real-email account: Firebase login (random password) + users row, then
// emails a set-password invite and starts the standard Aivorah email verification.
async function createUser({ name, email, role, school, curriculum, grade, section, frontendOrigin }, adminEmail) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanName) throw new AdminUserError(400, 'Name is required');
  if (!EMAIL_RE.test(cleanEmail)) throw new AdminUserError(400, 'Enter a valid email address');
  if (!ROLES.includes(role)) throw new AdminUserError(400, `Role must be one of ${ROLES.join(', ')}`);
  if (!firebaseAdmin) throw new AdminUserError(500, 'Auth is not configured on this server');
  if (!process.env.RESEND_API_KEY && !(process.env.EMAIL_USER && process.env.EMAIL_PASS)) {
    throw new AdminUserError(503, 'Email sending is not configured on this server');
  }

  const row = { name: cleanName, email: cleanEmail, role, status: 'active' };
  if (school) {
    const { data: sc } = await supabase.from('schools').select('id, name').eq('name', school).maybeSingle();
    if (!sc) throw new AdminUserError(400, `School "${school}" not found`);
    row.school = sc.name; row.school_id = sc.id;
  } else if (role === 'school_admin') {
    throw new AdminUserError(400, 'A school admin needs a school');
  }
  if (role === 'student') {
    const c = String(curriculum || '').trim(); const g = String(grade || '').trim();
    if (!CURRICULA.includes(c)) throw new AdminUserError(400, 'A student needs a valid curriculum');
    if (!GRADE_RE.test(g)) throw new AdminUserError(400, 'A student needs a grade like "Grade 3"');
    row.curriculum = c; row.grade = g; row.section = String(section || '').trim() || null;
    if (row.section && row.section.length > 20) throw new AdminUserError(400, 'Section is too long');
  }
  // Students and school admins are fully set up here; teachers and parents finish their own onboarding.
  row.onboarding_complete = role === 'student' || role === 'school_admin';

  const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
  if (existing) throw new AdminUserError(409, 'An account with this email already exists');
  let fbUser = null;
  try { fbUser = await firebaseAdmin.auth().getUserByEmail(cleanEmail); } catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
  if (fbUser) throw new AdminUserError(409, 'This email is already registered — ask them to sign in or reset their password');

  let created;
  try {
    created = await firebaseAdmin.auth().createUser({
      email: cleanEmail, password: randomUUID() + 'Aa1!', displayName: `${cleanName}|${role}`, emailVerified: false,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') throw new AdminUserError(409, 'This email is already registered — ask them to sign in or reset their password');
    throw err;
  }
  const id = randomUUID();
  const { error } = await supabase.from('users').insert({ id, ...row });
  if (error) {
    await firebaseAdmin.auth().deleteUser(created.uid).catch(() => {});
    throw error;
  }

  await audit(adminEmail, 'user.create', { id, email: cleanEmail }, { role, school: row.school || null });

  // Account is kept if the invite fails; the admin can resend via "Send password reset".
  const appBase = ORIGIN_RE.test(String(frontendOrigin || '')) ? frontendOrigin : APP_URL;
  let inviteSent = false; let inviteError = null;
  try {
    const link = await firebaseAdmin.auth().generatePasswordResetLink(cleanEmail, { url: `${appBase}/` });
    await sendEmail({ to: cleanEmail, subject: `You've been invited to Aivorah as a ${ROLE_LABEL[role]}`, html: inviteHtml({ name: cleanName, roleLabel: ROLE_LABEL[role], link }) });
    inviteSent = true;
  } catch (err) {
    console.warn('[adminUsers] invite email failed:', err.message);
    inviteError = 'Account created, but the invite email could not be sent. Use "Send password reset" to retry.';
  }

  let verificationSent = false;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/user/send-verification`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, name: cleanName, frontendOrigin: appBase }),
    });
    verificationSent = res.ok;
    if (!res.ok) console.warn('[adminUsers] send-verification failed:', res.status);
  } catch (err) {
    console.warn('[adminUsers] send-verification failed:', err.message);
  }

  return { user: { id, ...row, status: 'active', isPlatformAdmin: false, last_active_at: null }, inviteSent, inviteError, verificationSent };
}

module.exports = { listUsers, createUser, updateUser, setBlocked, sendPasswordReset, AdminUserError, ROLES, PAGE_SIZE };
