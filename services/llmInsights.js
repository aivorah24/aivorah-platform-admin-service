// AI-written summary of LLM usage aggregates. Only totals/model/day figures are sent — never emails or prompts.
const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // days -> { at, value }

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 100) : null);

function aggregatesFor(stats) {
  const { days, summary, previous, byModel, byDay, byFeature } = stats;
  return {
    days,
    current: { calls: summary.totalCalls, tokens: summary.totalTokens, costUsd: +summary.totalCost.toFixed(4), avgResponseMs: summary.avgResponseMs },
    previous: { calls: previous.totalCalls, tokens: previous.totalTokens, costUsd: +previous.totalCost.toFixed(4), avgResponseMs: previous.avgResponseMs },
    models: byModel.slice(0, 6).map((m) => ({ model: m.model, calls: m.calls, tokens: m.tokens, costUsd: +m.cost.toFixed(4), costSharePct: Math.round(m.costShare * 100), avgResponseMs: m.avgResponseMs, helpfulPct: m.helpfulPct })),
    features: byFeature.slice(0, 6).map((f) => ({ feature: f.feature, calls: f.calls, tokens: f.tokens })),
    dailyCostUsd: byDay.map((d) => +d.cost.toFixed(4)),
    dailyCalls: byDay.map((d) => d.calls),
  };
}

function fallbackText(stats) {
  const { summary, previous, byModel, byFeature, days } = stats;
  if (!summary.totalCalls) return `No AI calls in the last ${days} days.`;
  const parts = [];
  const top = byModel[0];
  if (top) parts.push(`${top.model} handled ${Math.round(top.callShare * 100)}% of ${summary.totalCalls.toLocaleString('en-US')} calls`);
  const c = pct(summary.totalCost, previous.totalCost);
  if (c != null) parts.push(`spend ${c >= 0 ? 'up' : 'down'} ${Math.abs(c)}% to ${money(summary.totalCost)} vs the previous ${days} days`);
  if (byFeature[0]) parts.push(`${byFeature[0].feature} is the busiest feature`);
  return `${parts.join('; ')}.`;
}

async function askGemini(aggregates) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const models = (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite,gemini-2.0-flash').split(',').map((s) => s.trim()).filter(Boolean);
  const prompt = 'You are reviewing LLM usage for an education platform admin. Using ONLY these aggregates, write one short paragraph (2-3 sentences, under 70 words): the biggest cost driver, the main change vs the previous period, and one concrete cost or speed suggestion. Plain text, no markdown, no greetings.\n\n'
    + JSON.stringify(aggregates);
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 300 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
      if (text) return { text, model };
    } catch (err) {
      console.warn('[llmInsights]', model, err.message);
    }
  }
  return null;
}

async function buildInsights(stats, now = Date.now()) {
  const hit = cache.get(stats.days);
  if (hit && now - hit.at < TTL_MS) return { ...hit.value, cached: true };
  const ai = stats.summary.totalCalls ? await askGemini(aggregatesFor(stats)) : null;
  const value = ai
    ? { text: ai.text, source: 'ai', model: ai.model, generatedAt: new Date(now).toISOString() }
    : { text: fallbackText(stats), source: 'summary', model: null, generatedAt: new Date(now).toISOString() };
  // Don't pin a fallback for an hour — retry the AI next request.
  if (ai) cache.set(stats.days, { at: now, value });
  return { ...value, cached: false };
}

module.exports = { buildInsights, aggregatesFor, fallbackText, _cache: cache };
