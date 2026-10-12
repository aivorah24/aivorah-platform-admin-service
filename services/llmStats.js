// Aggregations for the admin LLM Usage dashboard. Pure: takes llm_logs rows, returns
// the response body — so the maths is unit-testable without a database.

// USD per 1M tokens, list prices (provider pages, Oct 2026) — only used when a row was
// logged with cost 0/null (older loggers had no price for these models). Free-tier keys
// aren't billed, so this is "what it would cost at list price".
const LIST_PRICE = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.75 },
  'openai/gpt-oss-20b': { input: 0.10, output: 0.50 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-flash-lite-latest': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
};

// What each logged route powers, for the "by feature" breakdown.
const ROUTE_LABELS = [
  [/^\/ask/, 'AI Coach'],
  [/learning|lesson|unit|topic/i, 'Learning Paths'],
  [/assign|quiz|worksheet/i, 'Assignments'],
  [/bedtime|story/i, 'Bedtime Stories'],
  [/world/i, 'World & You'],
  [/help/i, 'Help Center'],
  [/timetable|resource/i, 'Timetable & Resources'],
];

const DAY_MS = 86400000;
const isFeedback = (r) => r.model === 'session_feedback';
const featureOf = (route) => (ROUTE_LABELS.find(([re]) => re.test(route || ''))?.[1]) || (route ? 'Other' : 'Unlabelled');

function costOf(r) {
  const stored = parseFloat(r.estimated_cost_usd || 0);
  if (stored > 0) return stored;
  const p = LIST_PRICE[r.model];
  if (!p) return 0;
  return ((r.prompt_tokens || 0) / 1e6) * p.input + ((r.completion_tokens || 0) / 1e6) * p.output;
}

function totals(rows) {
  const calls = rows.length;
  const tokens = rows.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const cost = rows.reduce((s, r) => s + costOf(r), 0);
  const avgResponseMs = calls ? Math.round(rows.reduce((s, r) => s + (r.response_time_ms || 0), 0) / calls) : 0;
  return { totalCalls: calls, totalTokens: tokens, totalCost: +cost.toFixed(6), avgResponseMs };
}

function dayKeys(sinceMs, days) {
  return Array.from({ length: days }, (_, i) => new Date(sinceMs + i * DAY_MS).toISOString().slice(0, 10));
}

// rows: llm_logs from (now - 2*days) onward; `now` injectable for tests.
function buildLlmStats(rows, days, now = Date.now()) {
  const todayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const since = todayStart - (days - 1) * DAY_MS;
  const prevSince = since - days * DAY_MS;
  const ts = (r) => new Date(r.created_at).getTime();

  const current = rows.filter((r) => ts(r) >= since);
  const previousRows = rows.filter((r) => ts(r) >= prevSince && ts(r) < since);
  const calls = current.filter((r) => !isFeedback(r));
  const prevCalls = previousRows.filter((r) => !isFeedback(r));
  const keys = dayKeys(since, days);

  const byDayMap = Object.fromEntries(keys.map((d) => [d, { date: d, calls: 0, tokens: 0, cost: 0, totalMs: 0 }]));
  for (const r of calls) {
    const d = byDayMap[r.created_at.slice(0, 10)];
    if (!d) continue;
    d.calls += 1; d.tokens += r.total_tokens || 0; d.cost += costOf(r); d.totalMs += r.response_time_ms || 0;
  }
  const byDay = keys.map((k) => {
    const { totalMs, ...d } = byDayMap[k];
    return { ...d, cost: +d.cost.toFixed(6), avgResponseMs: d.calls ? Math.round(totalMs / d.calls) : 0 };
  });

  const summary = totals(calls);
  const models = {};
  for (const r of calls) {
    const m = (models[r.model] ||= { model: r.model, provider: r.provider || 'unknown', calls: 0, tokens: 0, cost: 0, totalMs: 0, rated: 0, helpful: 0, trendMap: {} });
    m.calls += 1; m.tokens += r.total_tokens || 0; m.cost += costOf(r); m.totalMs += r.response_time_ms || 0;
    // Students rate a session 1–3 on the call's own row (tokenLogger.saveFeedback); 3 = helpful.
    const rating = Number(r.feedback);
    if (rating >= 1 && rating <= 3) { m.rated += 1; if (rating === 3) m.helpful += 1; }
    const day = r.created_at.slice(0, 10);
    m.trendMap[day] = (m.trendMap[day] || 0) + (r.total_tokens || 0);
  }
  const byModel = Object.values(models)
    .map(({ trendMap, totalMs, ...m }) => ({
      ...m,
      cost: +m.cost.toFixed(6),
      avgResponseMs: m.calls ? Math.round(totalMs / m.calls) : 0,
      costShare: summary.totalCost ? +(m.cost / summary.totalCost).toFixed(4) : 0,
      callShare: summary.totalCalls ? +(m.calls / summary.totalCalls).toFixed(4) : 0,
      helpfulPct: m.rated ? Math.round((m.helpful / m.rated) * 100) : null,
      trend: keys.map((k) => trendMap[k] || 0),
    }))
    .sort((a, b) => b.calls - a.calls);

  const features = {};
  for (const r of calls) {
    const f = (features[featureOf(r.route)] ||= { feature: featureOf(r.route), calls: 0, tokens: 0 });
    f.calls += 1; f.tokens += r.total_tokens || 0;
  }

  const providers = {};
  for (const r of calls) { const p = r.provider || 'unknown'; providers[p] = (providers[p] || 0) + 1; }

  const feedbackRows = current.filter((r) => isFeedback(r) && r.feedback);
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const r of feedbackRows) { const n = Number(r.feedback); if (n >= 1 && n <= 3) counts[n] += 1; }

  return {
    days,
    range: { from: keys[0], to: keys[keys.length - 1] },
    summary: { ...summary, activeModels: byModel.length },
    previous: totals(prevCalls),
    lastCallAt: calls[0]?.created_at || rows.find((r) => !isFeedback(r))?.created_at || null,
    byDay,
    byModel,
    byFeature: Object.values(features).sort((a, b) => b.calls - a.calls),
    byProvider: Object.entries(providers).map(([provider, n]) => ({ provider, calls: n })),
    feedback: {
      total: feedbackRows.length,
      avg: feedbackRows.length ? +(feedbackRows.reduce((s, r) => s + Number(r.feedback || 0), 0) / feedbackRows.length).toFixed(1) : null,
      counts,
      recent: feedbackRows.slice(0, 10),
    },
    recent: calls.slice(0, 20).map((r) => ({
      created_at: r.created_at, model: r.model, provider: r.provider, route: r.route, feature: featureOf(r.route),
      total_tokens: r.total_tokens || 0, cost: +costOf(r).toFixed(6), response_time_ms: r.response_time_ms || 0,
      feedback: Number(r.feedback) || null,
    })),
  };
}

module.exports = { buildLlmStats, costOf, featureOf, LIST_PRICE };
