// PATCH /schools/:id against an in-memory Supabase stand-in.
const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

const mockDb = { schools: [], analytics_events: [] };

function mockQuery(table) {
  const filters = [];
  let pending = null;
  const q = {
    select: () => q,
    eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
    insert: (row) => { pending = { row }; return q; },
    update: (patch) => { pending = { patch }; return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    then: (resolve) => resolve(run()),
  };
  const rows = () => mockDb[table].filter((r) => filters.every((f) => f(r)));
  function run() {
    if (pending?.patch) rows().forEach((r) => Object.assign(r, pending.patch));
    else if (pending?.row) mockDb[table].push({ ...pending.row });
    return { data: null, error: null };
  }
  return q;
}

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async (tok) => ({ email: tok === 'allowed' ? 'allowed@aivorah.test' : 'nobody@x.test' })) }),
}));
jest.mock('../services/supabase', () => ({ from: (t) => mockQuery(t) }));

const app = require('../index');
const patch = (id, body, tok = 'allowed') => request(app).patch(`/schools/${id}`).set('Authorization', `Bearer ${tok}`).send(body);

beforeEach(() => {
  mockDb.schools = [{ id: 'a', name: 'Blank', curriculum: null }, { id: 'b', name: 'TSRA', curriculum: 'IB' }];
  mockDb.analytics_events = [];
});

describe('PATCH /schools/:id', () => {
  test('admin-only', async () => {
    expect((await request(app).patch('/schools/a').send({ curriculum: 'IB' })).status).toBe(401);
    expect((await patch('a', { curriculum: 'IB' }, 'other')).status).toBe(403);
    expect(mockDb.schools[0].curriculum).toBeNull();
  });

  test('sets the curriculum (normalised) and audits from → to', async () => {
    const res = await patch('b', { curriculum: 'cbse' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'b', name: 'TSRA', curriculum: 'CBSE' });
    expect(mockDb.schools[1].curriculum).toBe('CBSE');
    expect(mockDb.analytics_events).toEqual([expect.objectContaining({
      event_type: 'admin_action', user_email: 'allowed@aivorah.test', page: 'school.set_curriculum',
      meta: expect.objectContaining({ targetId: 'b', from: 'IB', to: 'CBSE' }),
    })]);
  });

  test('rejects an invalid curriculum and an unknown school', async () => {
    expect((await patch('a', { curriculum: 'IB PYP' })).status).toBe(400);
    expect((await patch('a', {})).status).toBe(400);
    expect((await patch('zzz', { curriculum: 'IB' })).status).toBe(404);
    expect(mockDb.schools[0].curriculum).toBeNull();
    expect(mockDb.analytics_events).toEqual([]);
  });
});
