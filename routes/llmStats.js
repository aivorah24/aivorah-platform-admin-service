const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { buildLlmStats } = require('../services/llmStats');
const { buildInsights } = require('../services/llmInsights');

const ALLOWED_DAYS = [1, 7, 30, 90];

const parseDays = (q) => {
  const asked = parseInt(q, 10);
  return ALLOWED_DAYS.includes(asked) ? asked : 7;
};

// Current window plus the same-length window before it.
async function loadStats(days) {
  const since = new Date(Date.now() - 2 * days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('llm_logs')
    .select('provider, model, route, student_email, grade, subject, topic, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, response_time_ms, streamed, feedback, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return buildLlmStats(data || [], days);
}

// GET /llm-stats?days=1|7|30|90
router.get('/', async (req, res) => {
  try {
    res.json(await loadStats(parseDays(req.query.days)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /llm-stats/insights?days=7|30|90 — only aggregates reach the LLM (see services/llmInsights).
router.get('/insights', async (req, res) => {
  try {
    const { text, source, model, generatedAt, cached } = await buildInsights(await loadStats(parseDays(req.query.days)));
    res.json({ text, source, model, generatedAt, cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
