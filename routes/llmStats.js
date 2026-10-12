const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { buildLlmStats } = require('../services/llmStats');

const ALLOWED_DAYS = [1, 7, 30, 90];

// GET /llm-stats?days=1|7|30|90 — current window plus the same-length window before it.
router.get('/', async (req, res) => {
  try {
    const asked = parseInt(req.query.days, 10);
    const days = ALLOWED_DAYS.includes(asked) ? asked : 7;
    const since = new Date(Date.now() - 2 * days * 86400000).toISOString();

    const { data, error } = await supabase
      .from('llm_logs')
      .select('provider, model, route, student_email, grade, subject, topic, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, response_time_ms, streamed, feedback, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json(buildLlmStats(data || [], days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
