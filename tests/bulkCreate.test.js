// POST /students/bulk-create (Quick add) against an in-memory Supabase stand-in.
const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

const mockDb = { users: [], schools: [], student_stats: [], user_preferences: [] };

function mockQuery(table) {
  const filters = [];
  let pending = null;
  const q = {
    select: () => q,
    eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
    insert: (row) => { pending = row; return q; },
    upsert: (row) => { pending = row; return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    then: (resolve) => resolve(run()),
  };
  const rows = () => mockDb[table].filter((r) => filters.every((f) => f(r)));
  function run() {
    if (pending) { [].concat(pending).forEach((r) => mockDb[table].push({ ...r })); return { data: null, error: null }; }
    return { data: rows(), error: null };
  }
  return q;
}

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));
jest.mock('../services/supabase', () => ({ from: (t) => mockQuery(t) }));
jest.mock('../services/studentAccounts', () => ({
  ...jest.requireActual('../services/studentAccounts'),
  createFirebaseAccount: jest.fn(async () => 'uid'),
  generateSecurePassword: () => 'Pw!12345',
}));

const app = require('../index');
const post = (body) => request(app).post('/students/bulk-create').set('Authorization', 'Bearer allowed').send(body);

beforeEach(() => {
  Object.keys(mockDb).forEach((k) => { mockDb[k] = []; });
  mockDb.schools.push({ id: 'sch1', name: 'TSRA', curriculum: 'IB' }, { id: 'sch2', name: 'Seed', curriculum: 'CBSE' });
});

describe('POST /students/bulk-create with schoolId', () => {
  test("uses the school's name and curriculum (IB by grade), ignoring client values", async () => {
    const res = await post({ schoolId: 'sch1', school: 'Wrong', curriculum: 'CBSE', grade: 'Grade 7', section: 'B', students: ['asha', { name: 'ben', curriculum: 'ICSE', grade: 'Grade 2' }] });
    expect(res.status).toBe(200);
    expect(res.body.created.map((c) => [c.name, c.curriculum, c.school])).toEqual([['Asha', 'IB MYP', 'TSRA'], ['Ben', 'IB PYP', 'TSRA']]);
    expect(mockDb.users.find((u) => u.name === 'Asha')).toMatchObject({ curriculum: 'IB MYP', school: 'TSRA', school_id: 'sch1', grade: 'Grade 7', section: 'B' });
  });

  test('a single-board school gives every student that board; no curriculum needs to be sent', async () => {
    const res = await post({ schoolId: 'sch2', grade: 'Grade 5', students: ['Cam'] });
    expect(res.status).toBe(200);
    expect(mockDb.users.find((u) => u.name === 'Cam')).toMatchObject({ curriculum: 'CBSE', school: 'Seed', school_id: 'sch2' });
  });

  test('requires a grade, and an unknown school is a 404', async () => {
    expect((await post({ schoolId: 'sch1', students: ['Cam'] })).status).toBe(400);
    expect((await post({ schoolId: 'nope', grade: 'Grade 5', students: ['Cam'] })).status).toBe(404);
    expect(mockDb.users).toHaveLength(0);
  });
});
