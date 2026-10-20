const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));

const mockToday = new Date().toISOString().slice(0, 10);
const mockRows = [
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask', student_email: 'kid@school.test', topic: 'Secret prompt topic', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost_usd: 0.002, response_time_ms: 800, feedback: 3, created_at: `${mockToday}T00:00:01Z` },
  { provider: 'google', model: 'gemini-2.5-flash', route: '/ask/stream', student_email: 'kid@school.test', prompt_tokens: 200, completion_tokens: 80, total_tokens: 280, estimated_cost_usd: 0.004, response_time_ms: 1200, feedback: null, created_at: `${mockToday}T00:00:02Z` },
];

jest.mock('../services/supabase', () => ({
  from: jest.fn(() => ({
    select: () => ({ gte: () => ({ order: () => Promise.resolve({ data: mockRows, error: null }) }) }),
  })),
}));

const app = require('../index');
const { aggregatesFor, _cache } = require('../services/llmInsights');
const { buildLlmStats } = require('../services/llmStats');

const realFetch = global.fetch;
const geminiReply = (text) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const get = (days) => request(app).get(`/llm-stats/insights?days=${days}`).set('Authorization', 'Bearer allowed');

beforeEach(() => {
  _cache.clear();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  global.fetch = jest.fn();
});
afterAll(() => { global.fetch = realFetch; });

describe('GET /llm-stats/insights', () => {
  test('rejects without a token', async () => {
    expect((await request(app).get('/llm-stats/insights')).status).toBe(401);
  });

  test('falls back to the rule-based summary when GEMINI_API_KEY is unset', async () => {
    const res = await get(7);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'summary', model: null, cached: false });
    expect(res.body.text).toMatch(/gemini-2.5-flash handled 100% of 2 calls/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('uses the Gemini answer when a key is set, and never sends emails or prompts', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-test';
    global.fetch.mockResolvedValue(geminiReply('Flash drives all spend.'));
    const res = await get(30);
    expect(res.body).toMatchObject({ text: 'Flash drives all spend.', source: 'ai', model: 'gemini-test', cached: false });
    expect(res.body.generatedAt).toEqual(expect.any(String));
    expect(global.fetch.mock.calls[0][1].body).not.toMatch(/kid@school\.test|student_email|Secret prompt topic/);
  });

  test('serves the second call for the same range from cache', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch.mockResolvedValue(geminiReply('Cached insight.'));
    await get(90);
    const res = await get(90);
    expect(res.body).toMatchObject({ text: 'Cached insight.', source: 'ai', cached: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('does not cache the fallback when Gemini fails', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-test';
    global.fetch.mockResolvedValue({ ok: false });
    expect((await get(7)).body.source).toBe('summary');
    global.fetch.mockResolvedValue(geminiReply('Recovered.'));
    expect((await get(7)).body).toMatchObject({ source: 'ai', text: 'Recovered.', cached: false });
  });
});

describe('aggregatesFor', () => {
  test('contains no student_email or prompt fields', () => {
    const json = JSON.stringify(aggregatesFor(buildLlmStats(mockRows, 7)));
    expect(json).not.toMatch(/student_email|kid@school\.test|Secret prompt topic|"topic"/);
    expect(JSON.parse(json).current).toMatchObject({ calls: 2, tokens: 430 });
  });
});
