const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const SCHOOLS = [
  { id: 'a', name: 'Seed Test School (CBSE)', curriculum: 'CBSE' },
  { id: 'b', name: 'TSRA', curriculum: 'IB' },
  { id: 'c', name: 'E2E School Mutate', curriculum: null },
];

jest.mock('../services/supabase', () => ({
  from: jest.fn((table) => {
    if (table === 'schools') {
      return { select: () => ({ order: () => Promise.resolve({ data: SCHOOLS, error: null }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  }),
}));

const app = require('../index');

describe('GET /schools', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/schools')).status).toBe(401);
  });

  test('returns each school with its board', async () => {
    const res = await request(app).get('/schools').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SCHOOLS);
  });
});
