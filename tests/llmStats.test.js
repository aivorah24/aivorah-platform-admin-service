const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const ROWS = [
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask', student_email: 'a@s.test', grade: 'Grade 5', subject: 'Maths', topic: 'Fractions', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost_usd: 0.002, response_time_ms: 800, streamed: true, feedback: null, created_at: '2026-10-07T10:00:00Z' },
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask', student_email: 'b@s.test', grade: 'Grade 6', subject: 'Science', topic: 'Light', prompt_tokens: 200, completion_tokens: 80, total_tokens: 280, estimated_cost_usd: 0.004, response_time_ms: 1200, streamed: true, feedback: null, created_at: '2026-10-07T11:00:00Z' },
  { provider: 'system', model: 'session_feedback', route: '/feedback', student_email: 'a@s.test', grade: null, subject: null, topic: null, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0, response_time_ms: 0, streamed: false, feedback: '3', created_at: '2026-10-07T12:00:00Z' },
];

jest.mock('../services/supabase', () => ({
  from: jest.fn(() => ({
    select: () => ({ gte: () => ({ order: () => Promise.resolve({ data: ROWS, error: null }) }) }),
  })),
}));

const app = require('../index');

describe('GET /llm-stats', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/llm-stats')).status).toBe(401);
  });

  test('aggregates totals, per-model, per-day and feedback, excluding session_feedback from model/calls', async () => {
    const res = await request(app).get('/llm-stats?days=7').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body.summary.totalCalls).toBe(3);
    expect(res.body.summary.totalTokens).toBe(430);
    expect(res.body.byModel).toEqual([{ model: 'gemini-2.5-flash', provider: 'google', calls: 2, tokens: 430, cost: 0.006 }]);
    expect(res.body.feedback).toEqual({ total: 1, avg: 3, counts: { 1: 0, 2: 0, 3: 1 }, recent: expect.any(Array) });
  });
});
