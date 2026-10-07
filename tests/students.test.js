const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';
process.env.FIREBASE_API_KEY = 'test-key';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const TABLES = {
  users: [
    { id: 's1', name: 'Asha', email: 'asha@s.test', role: 'student', grade: 'Grade 5', school: 'TSRA', section: 'A', created_at: '2026-01-01', student_stats: {} },
    { id: 's2', name: 'Ben', email: 'ben@s.test', role: 'student', grade: 'Grade 5', school: 'TSRA', section: 'A', created_at: '2026-01-02', student_stats: {} },
    { id: 't1', name: 'Ms Rao', email: 'rao@s.test', role: 'teacher', school: 'TSRA', curriculum: 'CBSE' },
  ],
  teacher_student: [{ student_id: 's1', teacher_id: 't1', subject: 'Maths' }],
  user_preferences: [{ user_email: 'rao@s.test', data: { teaches: [{ grade: 'Grade 5', subject: 'Maths' }] } }],
};

function mockSupabase() {
  const mk = (table) => {
    const state = { table, filters: [] };
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn((col, val) => { state.filters.push(['eq', col, val]); return chain; }),
      ilike: jest.fn(() => chain),
      in: jest.fn(() => chain),
      order: jest.fn(() => resolve()),
      maybeSingle: jest.fn(() => resolve(true)),
      insert: jest.fn((rows) => { state.inserted = rows; return resolve(); }),
      upsert: jest.fn((rows) => { state.upserted = rows; return resolve(); }),
      then: (cb) => resolve().then(cb),
    };
    function resolve(single) {
      let rows = TABLES[table] || [];
      for (const [, col, val] of state.filters) rows = rows.filter((r) => r[col] === val);
      if (single) return Promise.resolve({ data: rows[0] || null, error: null });
      return Promise.resolve({ data: rows, error: null });
    }
    return chain;
  };
  return { from: jest.fn((table) => mk(table)) };
}
jest.mock('../services/supabase', () => mockSupabase());

const app = require('../index');

describe('GET /students', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/students')).status).toBe(401);
  });

  test('lists students with their teacher assignments merged in', async () => {
    const res = await request(app).get('/students').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    const asha = res.body.students.find((s) => s.id === 's1');
    expect(asha.teacher_student).toEqual([expect.objectContaining({ teacher_id: 't1', subject: 'Maths', teacher: expect.objectContaining({ id: 't1', name: 'Ms Rao', email: 'rao@s.test' }) })]);
  });
});

describe('POST /students/assign-teacher', () => {
  test('requires studentIds and teacherEmail', async () => {
    const res = await request(app).post('/students/assign-teacher').set('Authorization', 'Bearer allowed').send({});
    expect(res.status).toBe(400);
  });

  test('404s when the teacher email does not match any user', async () => {
    const res = await request(app).post('/students/assign-teacher').set('Authorization', 'Bearer allowed')
      .send({ studentIds: ['s1'], teacherEmail: 'nobody@s.test' });
    expect(res.status).toBe(404);
  });

  test('assigns students to the matched teacher', async () => {
    const res = await request(app).post('/students/assign-teacher').set('Authorization', 'Bearer allowed')
      .send({ studentIds: ['s1', 's2'], teacherEmail: 'rao@s.test', subject: 'Science' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, assigned: 2 });
  });
});

describe('POST /students/bulk-create', () => {
  test('requires a non-empty students array', async () => {
    const res = await request(app).post('/students/bulk-create').set('Authorization', 'Bearer allowed').send({ students: [] });
    expect(res.status).toBe(400);
  });

  test('requires grade and curriculum when not using per-row values', async () => {
    const res = await request(app).post('/students/bulk-create').set('Authorization', 'Bearer allowed').send({ students: ['Cam'] });
    expect(res.status).toBe(400);
  });
});
