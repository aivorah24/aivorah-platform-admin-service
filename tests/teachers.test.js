const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const TEACHERS = [
  { id: 't1', name: 'Ms Rao', email: 'rao@s.test', school: 'TSRA', curriculum: 'CBSE' },
  { id: 't2', name: 'Mr Old', email: 'old@s.test', school: 'TSRA', curriculum: 'NCERT' },
];
const PREFS = [
  { user_email: 'rao@s.test', data: { teaches: [{ grade: 'Grade 5', subject: 'Maths' }] } },
  { user_email: 'old@s.test', data: { teaches: [{ grade: 'Grade 8', curriculum: 'ncert' }] } },
];

jest.mock('../services/supabase', () => ({
  from: jest.fn((table) => {
    if (table === 'users') {
      return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: TEACHERS, error: null }) }) }) };
    }
    if (table === 'user_preferences') {
      return { select: () => ({ in: () => Promise.resolve({ data: PREFS, error: null }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  }),
}));

const app = require('../index');

describe('GET /teachers', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/teachers')).status).toBe(401);
  });

  test('returns each teacher with their teaches[] merged from user_preferences', async () => {
    const res = await request(app).get('/teachers').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ id: 't1', name: 'Ms Rao', email: 'rao@s.test', school: 'TSRA', curriculum: 'CBSE', teaches: [{ grade: 'Grade 5', subject: 'Maths' }] });
  });

  test('legacy NCERT teachers (row + teaches[]) come back as CBSE', async () => {
    const res = await request(app).get('/teachers').set('Authorization', 'Bearer allowed');
    expect(res.body[1]).toMatchObject({ curriculum: 'CBSE', teaches: [{ grade: 'Grade 8', curriculum: 'CBSE' }] });
  });
});
