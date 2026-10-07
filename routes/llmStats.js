const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// GET /llm-stats?days=7 — ported from the monolith's routes/admin.js GET
// /llm-stats, onto the Test DB.
router.get('/', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    const { data, error } = await supabase
      .from('llm_logs')
      .select('provider, model, route, student_email, grade, subject, topic, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, response_time_ms, streamed, feedback, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];

    const totalCalls = rows.length;
    const totalTokens = rows.reduce((s, r) => s + (r.total_tokens || 0), 0);
    const totalCost = rows.reduce((s, r) => s + parseFloat(r.estimated_cost_usd || 0), 0);
    const avgResponseMs = totalCalls ? Math.round(rows.reduce((s, r) => s + (r.response_time_ms || 0), 0) / totalCalls) : 0;

    const byModel = {};
    for (const r of rows) {
      const key = r.model;
      if (!byModel[key]) byModel[key] = { model: key, provider: r.provider, calls: 0, tokens: 0, cost: 0 };
      byModel[key].calls++;
      byModel[key].tokens += r.total_tokens || 0;
      byModel[key].cost += parseFloat(r.estimated_cost_usd || 0);
    }

    const byDay = {};
    for (const r of rows) {
      const day = r.created_at.slice(0, 10);
      if (!byDay[day]) byDay[day] = { date: day, calls: 0, tokens: 0, cost: 0 };
      byDay[day].calls++;
      byDay[day].tokens += r.total_tokens || 0;
      byDay[day].cost += parseFloat(r.estimated_cost_usd || 0);
    }

    const byProvider = {};
    for (const r of rows) {
      if (r.model === 'session_feedback') continue;
      const p = r.provider || 'unknown';
      if (!byProvider[p]) byProvider[p] = { provider: p, calls: 0 };
      byProvider[p].calls++;
    }

    const feedbackRows = rows.filter((r) => r.model === 'session_feedback' && r.feedback);
    const feedbackCounts = { 1: 0, 2: 0, 3: 0 };
    for (const r of feedbackRows) {
      const rating = Number(r.feedback);
      if (rating >= 1 && rating <= 3) feedbackCounts[rating]++;
    }
    const totalFeedback = feedbackRows.length;
    const avgRating = totalFeedback
      ? parseFloat((feedbackRows.reduce((s, r) => s + Number(r.feedback || 0), 0) / totalFeedback).toFixed(1))
      : null;

    res.json({
      days,
      summary: { totalCalls, totalTokens, totalCost: parseFloat(totalCost.toFixed(6)), avgResponseMs },
      byModel: Object.values(byModel).filter((m) => m.model !== 'session_feedback').sort((a, b) => b.calls - a.calls),
      byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
      byProvider: Object.values(byProvider),
      feedback: { total: totalFeedback, avg: avgRating, counts: feedbackCounts, recent: feedbackRows.slice(0, 10) },
      recent: rows.filter((r) => r.model !== 'session_feedback').slice(0, 50),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
