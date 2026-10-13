const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

const mockDb = { users: [], schools: [], notifications: [], analytics_events: [] };
const mockFb = { disabled: {}, revoked: [], displayNames: {}, failUpdate: false, uids: { 'asha@s.test': 'uid-asha', 'ben@s.test': 'uid-ben' } };

function mockQuery(table) {
  const filters = [];
  let pending = null;
  let rangeArgs = null;
  const rows = () => mockDb[table].filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    order: () => q,
    eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
    neq: (k, v) => { filters.push((r) => r[k] !== v); return q; },
    or: (expr) => {
      const term = /%([^%]+)%/.exec(expr)[1].toLowerCase();
      filters.push((r) => ['name', 'email', 'school'].some((k) => String(r[k] || '').toLowerCase().includes(term)));
      return q;
    },
    range: (a, b) => { rangeArgs = [a, b]; return q; },
    insert: (row) => { pending = { op: 'insert', row }; return q; },
    update: (patch) => { pending = { op: 'update', patch }; return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    then: (resolve) => {
      if (pending?.op === 'insert') { [].concat(pending.row).forEach((r) => mockDb[table].push({ ...r })); return resolve({ data: null, error: null }); }
      if (pending?.op === 'update') { rows().forEach((r) => Object.assign(r, pending.patch)); return resolve({ data: null, error: null }); }
      const all = rows();
      return resolve({ data: rangeArgs ? all.slice(rangeArgs[0], rangeArgs[1] + 1) : all, error: null, count: all.length });
    },
  };
  return q;
}

jest.mock('../services/supabase', () => ({ from: (t) => mockQuery(t) }));
jest.mock('../services/mailer', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({
    verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })),
    getUserByEmail: jest.fn(async (email) => {
      if (!mockFb.uids[email]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return { uid: mockFb.uids[email] };
    }),
    updateUser: jest.fn(async (uid, props) => {
      if (mockFb.failUpdate && props.displayName) throw new Error('firebase down');
      if ('disabled' in props) mockFb.disabled[uid] = props.disabled;
      if (props.displayName) mockFb.displayNames[uid] = props.displayName;
    }),
    revokeRefreshTokens: jest.fn(async (uid) => { mockFb.revoked.push(uid); }),
    generatePasswordResetLink: jest.fn(async () => 'https://reset.example/link'),
    createUser: jest.fn(async ({ email }) => { mockFb.uids[email] = `uid-${email}`; return { uid: mockFb.uids[email] }; }),
    deleteUser: jest.fn(async () => {}),
  }),
}));

const app = require('../index');
const auth = (r) => r.set('Authorization', 'Bearer allowed');

beforeEach(() => {
  mockDb.users = [
    { id: 'u1', name: 'Asha Rao', email: 'asha@s.test', role: 'student', school: 'TSRA', school_id: 'sch1', status: 'active', created_at: '2026-10-01' },
    { id: 'u2', name: 'Ben Kumar', email: 'ben@s.test', role: 'teacher', school: 'TSRA', school_id: 'sch1', status: 'blocked', created_at: '2026-10-02' },
    { id: 'u3', name: 'Platform Admin', email: 'allowed@aivorah.test', role: 'student', school: null, status: 'active', created_at: '2026-10-03' },
    { id: 'u4', name: 'Priya Parent', email: 'priya@p.test', role: 'parent', school: null, status: 'active', created_at: '2026-10-04' },
  ];
  mockDb.schools = [{ id: 'sch1', name: 'TSRA' }, { id: 'sch2', name: 'Seed Test School (CBSE)' }];
  mockDb.notifications = []; mockDb.analytics_events = [];
  mockFb.disabled = {}; mockFb.revoked = []; mockFb.displayNames = {}; mockFb.failUpdate = false;
});

describe('GET /admin/users', () => {
  test('requires sign-in', async () => {
    expect((await request(app).get('/admin/users')).status).toBe(401);
  });

  test('filters by search, role and status, and flags platform admins', async () => {
    const all = await auth(request(app).get('/admin/users'));
    expect(all.body.total).toBe(4);
    expect(all.body.users.find((u) => u.id === 'u3').isPlatformAdmin).toBe(true);
    expect((await auth(request(app).get('/admin/users?q=kumar'))).body.users.map((u) => u.id)).toEqual(['u2']);
    expect((await auth(request(app).get('/admin/users?role=teacher'))).body.users.map((u) => u.id)).toEqual(['u2']);
    expect((await auth(request(app).get('/admin/users?status=blocked'))).body.users.map((u) => u.id)).toEqual(['u2']);
    expect((await auth(request(app).get('/admin/users?status=active'))).body.total).toBe(3);
  });
});

describe('PATCH /admin/users/:id', () => {
  test('updates name, role and school (with school_id), notifies the user and audits the change', async () => {
    const res = await auth(request(app).patch('/admin/users/u1')).send({ name: 'Asha R', role: 'teacher', school: 'Seed Test School (CBSE)' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['name', 'role', 'school']);
    expect(mockDb.users[0]).toMatchObject({ name: 'Asha R', role: 'teacher', school: 'Seed Test School (CBSE)', school_id: 'sch2' });
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject({ recipient_id: 'u1', type: 'account_updated', title: 'Your role has been updated to Teacher' });
    expect(mockDb.notifications[0].body).toMatch(/As per your request.*name: Asha R; role: Teacher; school: Seed Test School \(CBSE\)/);
    expect(mockDb.analytics_events[0]).toMatchObject({ event_type: 'admin_action', user_email: 'allowed@aivorah.test', page: 'user.update' });
    expect(mockFb.displayNames['uid-asha']).toBe('Asha R|teacher');
  });

  test('each single-field change gets its own title; several get a generic one', async () => {
    const patch = (body) => auth(request(app).patch('/admin/users/u1')).send(body);
    await patch({ name: 'Asha N' });
    await patch({ school: 'Seed Test School (CBSE)' });
    await patch({ section: 'C' });
    await patch({ grade: 'Grade 4', curriculum: 'CBSE' });
    expect(mockDb.notifications.map((n) => n.title)).toEqual([
      'Your name has been updated', 'Your school has been updated', 'Your section has been updated', 'Your account details have been updated',
    ]);
    expect(new Set(mockDb.notifications.map((n) => n.event_key)).size).toBe(4);
    expect(mockFb.displayNames['uid-asha']).toBe('Asha N|student');
  });

  test('only name/role changes touch the Firebase displayName', async () => {
    await auth(request(app).patch('/admin/users/u1')).send({ section: 'D' });
    expect(mockFb.displayNames).toEqual({});
  });

  test('parents are notified too, without a child_id', async () => {
    const res = await auth(request(app).patch('/admin/users/u4')).send({ name: 'Priya P' });
    expect(res.status).toBe(200);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject({ recipient_id: 'u4', recipient_role: 'parent', type: 'account_updated', title: 'Your name has been updated' });
    expect(mockDb.notifications[0].child_id).toBeUndefined();
  });

  test('a Firebase displayName failure does not fail the edit', async () => {
    mockFb.failUpdate = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await auth(request(app).patch('/admin/users/u1')).send({ role: 'teacher' });
    expect(res.status).toBe(200);
    expect(mockDb.users[0].role).toBe('teacher');
    expect(mockDb.notifications).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[adminUsers] displayName sync failed:', 'firebase down');
    warn.mockRestore();
  });

  test('no-op edits change nothing and send no notification; bad input is rejected', async () => {
    expect((await auth(request(app).patch('/admin/users/u1')).send({ name: 'Asha Rao' })).body.changed).toEqual([]);
    expect(mockDb.notifications).toHaveLength(0);
    expect((await auth(request(app).patch('/admin/users/u1')).send({ name: '  ' })).status).toBe(400);
    expect((await auth(request(app).patch('/admin/users/u1')).send({ role: 'super_admin' })).status).toBe(400);
    expect((await auth(request(app).patch('/admin/users/u1')).send({ school: 'Nowhere' })).status).toBe(400);
    expect((await auth(request(app).patch('/admin/users/u3')).send({ role: 'teacher' })).status).toBe(403);
    expect((await auth(request(app).patch('/admin/users/missing')).send({ name: 'X' })).status).toBe(404);
  });
});

describe('PATCH /admin/users/:id — student academics', () => {
  test('changing to student requires curriculum + grade, then saves them and notifies', async () => {
    expect((await auth(request(app).patch('/admin/users/u2')).send({ role: 'student' })).status).toBe(400);
    expect((await auth(request(app).patch('/admin/users/u2')).send({ role: 'student', curriculum: 'IB PYP', grade: '3' })).status).toBe(400);
    expect((await auth(request(app).patch('/admin/users/u2')).send({ role: 'student', curriculum: 'Nope', grade: 'Grade 3' })).status).toBe(400);
    const res = await auth(request(app).patch('/admin/users/u2')).send({ role: 'student', curriculum: 'IB PYP', grade: 'Grade 3', section: 'A' });
    expect(res.status).toBe(200);
    expect(mockDb.users[1]).toMatchObject({ role: 'student', curriculum: 'IB PYP', grade: 'Grade 3', section: 'A' });
    expect(mockDb.notifications[0]).toMatchObject({ recipient_id: 'u2', recipient_role: 'student', title: 'Your role has been updated to Student' });
  });

  test('editing an existing student without academics still works', async () => {
    expect((await auth(request(app).patch('/admin/users/u1')).send({ name: 'Asha Q' })).status).toBe(200);
  });
});

describe('block / unblock', () => {
  test('blocking disables the Firebase account, revokes sessions and sets status; unblocking restores', async () => {
    const res = await auth(request(app).post('/admin/users/u1/block')).send({ reason: 'Policy violation', signOut: true });
    expect(res.status).toBe(200);
    expect(mockDb.users[0].status).toBe('blocked');
    expect(mockFb.disabled['uid-asha']).toBe(true);
    expect(mockFb.revoked).toEqual(['uid-asha']);
    expect(mockDb.analytics_events[0].meta).toMatchObject({ action: 'user.block', reason: 'Policy violation' });

    expect(mockDb.notifications).toHaveLength(0);

    await auth(request(app).post('/admin/users/u1/unblock'));
    expect(mockDb.users[0].status).toBe('active');
    expect(mockFb.disabled['uid-asha']).toBe(false);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject({ recipient_id: 'u1', type: 'account_updated', title: 'Your account access has been restored' });
  });

  test('unblocking an already-active user sends no notice', async () => {
    await auth(request(app).post('/admin/users/u1/unblock'));
    expect(mockDb.notifications).toHaveLength(0);
  });

  test("can't block yourself or another platform admin", async () => {
    const res = await auth(request(app).post('/admin/users/u3/block')).send({});
    expect(res.status).toBe(403);
    expect(mockDb.users[2].status).toBe('active');
  });

  test('bulk block reports per-user results and skips protected accounts', async () => {
    const res = await auth(request(app).post('/admin/users/bulk-block')).send({ ids: ['u1', 'u3'] });
    expect(res.body.results).toEqual([{ id: 'u1', ok: true }, expect.objectContaining({ id: 'u3', ok: false, status: 403 })]);
    expect((await auth(request(app).post('/admin/users/bulk-unblock')).send({ ids: [] })).status).toBe(400);
  });
});

describe('POST /admin/users/:id/reset-password', () => {
  test('refuses when the server has no email provider, sends when it does', async () => {
    expect((await auth(request(app).post('/admin/users/u1/reset-password'))).status).toBe(503);
    process.env.RESEND_API_KEY = 'test';
    const res = await auth(request(app).post('/admin/users/u1/reset-password'));
    delete process.env.RESEND_API_KEY;
    expect(res.status).toBe(200);
    expect(require('../services/mailer').sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'asha@s.test' }));
  });
});

describe('POST /admin/users', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    require('../services/mailer').sendEmail.mockClear();
  });
  afterEach(() => { delete process.env.RESEND_API_KEY; });

  test('creates a student with academics, emails an invite and starts verification', async () => {
    const res = await auth(request(app).post('/admin/users')).send({
      name: 'Riya Shah', email: 'Riya@Real.test', role: 'student', school: 'TSRA', curriculum: 'IB PYP', grade: 'Grade 3', section: 'B',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ inviteSent: true, verificationSent: true });
    expect(mockDb.users.find((u) => u.email === 'riya@real.test')).toMatchObject({
      role: 'student', school_id: 'sch1', curriculum: 'IB PYP', grade: 'Grade 3', section: 'B', onboarding_complete: true,
    });
    expect(require('../services/mailer').sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'riya@real.test' }));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/user\/send-verification$/), expect.anything());
    expect(mockDb.analytics_events[0]).toMatchObject({ page: 'user.create' });
  });

  test('teachers and parents finish their own onboarding; school admins need a school', async () => {
    await auth(request(app).post('/admin/users')).send({ name: 'T One', email: 't1@real.test', role: 'teacher' });
    expect(mockDb.users.find((u) => u.email === 't1@real.test').onboarding_complete).toBe(false);
    expect((await auth(request(app).post('/admin/users')).send({ name: 'SA', email: 'sa@real.test', role: 'school_admin' })).status).toBe(400);
  });

  test('rejects bad input and existing emails', async () => {
    const post = (body) => auth(request(app).post('/admin/users')).send(body);
    expect((await post({ name: '', email: 'x@real.test', role: 'teacher' })).status).toBe(400);
    expect((await post({ name: 'X', email: 'not-an-email', role: 'teacher' })).status).toBe(400);
    expect((await post({ name: 'X', email: 'x@real.test', role: 'student', curriculum: 'IB PYP' })).status).toBe(400);
    expect((await post({ name: 'X', email: 'asha@s.test', role: 'teacher' })).status).toBe(409);
  });

  test('keeps the account and reports inviteSent:false when the invite email fails', async () => {
    require('../services/mailer').sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const res = await auth(request(app).post('/admin/users')).send({ name: 'Mail Fail', email: 'mf@real.test', role: 'teacher' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ inviteSent: false, verificationSent: true });
    expect(res.body.inviteError).toMatch(/could not be sent/);
    expect(mockDb.users.find((u) => u.email === 'mf@real.test')).toBeTruthy();
    expect(mockDb.analytics_events[0]).toMatchObject({ page: 'user.create' });
  });

  test('ignores a malformed frontendOrigin for the invite link', async () => {
    const fb = require('../services/firebaseAdmin').auth;
    const spy = jest.fn(async () => 'https://reset.example/link');
    require('../services/firebaseAdmin').auth = () => ({ ...fb(), generatePasswordResetLink: spy });
    try {
      await auth(request(app).post('/admin/users')).send({ name: 'O', email: 'o@real.test', role: 'teacher', frontendOrigin: 'https://evil.test/path?x' });
      expect(spy).toHaveBeenCalledWith('o@real.test', { url: 'https://aivorah.ai/' });
    } finally { require('../services/firebaseAdmin').auth = fb; }
  });

  test('refuses when the server cannot send email', async () => {
    delete process.env.RESEND_API_KEY;
    expect((await auth(request(app).post('/admin/users')).send({ name: 'X', email: 'y@real.test', role: 'teacher' })).status).toBe(503);
  });
});
