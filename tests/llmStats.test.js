const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const mockToday = new Date().toISOString().slice(0, 10);
const mockRows = [
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost_usd: 0.002, response_time_ms: 800, feedback: null, created_at: `${mockToday}T00:00:01Z` },
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask/stream', prompt_tokens: 200, completion_tokens: 80, total_tokens: 280, estimated_cost_usd: 0.004, response_time_ms: 1200, feedback: null, created_at: `${mockToday}T00:00:02Z` },
  { provider: 'system', model: 'session_feedback', route: '/feedback', total_tokens: 0, estimated_cost_usd: 0, response_time_ms: 0, feedback: '3', created_at: `${mockToday}T00:00:03Z` },
];

jest.mock('../services/supabase', () => ({
  from: jest.fn(() => ({
    select: () => ({ gte: () => ({ order: () => Promise.resolve({ data: mockRows, error: null }) }) }),
  })),
}));

const app = require('../index');
const { buildLlmStats, costOf, featureOf } = require('../services/llmStats');

describe('GET /llm-stats', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/llm-stats')).status).toBe(401);
  });

  test('counts only real AI calls (not session feedback) and returns per-model, per-day and feedback', async () => {
    const res = await request(app).get('/llm-stats?days=7').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalCalls: 2, totalTokens: 430, totalCost: 0.006, activeModels: 1 });
    expect(res.body.byModel[0]).toMatchObject({ model: 'gemini-2.5-flash', calls: 2, tokens: 430, cost: 0.006, callShare: 1 });
    expect(res.body.byDay).toHaveLength(7);
    expect(res.body.feedback).toMatchObject({ total: 1, avg: 3, counts: { 1: 0, 2: 0, 3: 1 } });
  });

  test('unsupported windows fall back to 7 days', async () => {
    const res = await request(app).get('/llm-stats?days=13').set('Authorization', 'Bearer allowed');
    expect(res.body.days).toBe(7);
  });
});

describe('buildLlmStats', () => {
  const NOW = Date.UTC(2026, 9, 10, 12); // 10 Oct 2026
  const row = (day, extra = {}) => ({ provider: 'groq', model: 'openai/gpt-oss-120b', route: '/ask/stream', prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000, estimated_cost_usd: 0, response_time_ms: 500, created_at: `2026-10-${day}T09:00:00Z`, ...extra });

  test('splits the current window from the previous one and fills empty days with zeros', () => {
    const out = buildLlmStats([row('10'), row('08'), row('06'), row('03')], 3, NOW); // window 08..10, previous 05..07
    expect(out.range).toEqual({ from: '2026-10-08', to: '2026-10-10' });
    expect(out.byDay.map((d) => [d.date, d.calls, d.avgResponseMs])).toEqual([['2026-10-08', 1, 500], ['2026-10-09', 0, 0], ['2026-10-10', 1, 500]]);
    expect(out.summary.totalCalls).toBe(2);
    expect(out.previous.totalCalls).toBe(1);
    expect(out.byModel[0].trend).toEqual([2000, 0, 2000]);
  });

  test('per-model quality: share of rated calls marked helpful (3), null when unrated; recent carries the rating', () => {
    const out = buildLlmStats([row('10', { feedback: 3 }), row('10', { feedback: 1 }), row('10'), row('10', { model: 'llama-3.3-70b-versatile' })], 3, NOW);
    const gpt = out.byModel.find((m) => m.model === 'openai/gpt-oss-120b');
    expect(gpt).toMatchObject({ rated: 2, helpful: 1, helpfulPct: 50 });
    expect(out.byModel.find((m) => m.model === 'llama-3.3-70b-versatile').helpfulPct).toBeNull();
    expect(out.recent[0].feedback).toBe(3);
  });

  test('prices zero-cost rows from the list price, keeps stored costs, and labels features', () => {
    expect(costOf(row('10'))).toBeCloseTo(0.0009); // 1k in @0.15 + 1k out @0.75 per 1M
    expect(costOf(row('10', { estimated_cost_usd: 0.5 }))).toBe(0.5);
    expect(costOf(row('10', { model: 'unknown-model' }))).toBe(0);
    expect(featureOf('/ask/stream')).toBe('AI Coach');
    expect(featureOf('/learning-paths/lesson')).toBe('Learning Paths');
    expect(featureOf(null)).toBe('Unlabelled');
  });
});
