const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { normalizeCurriculum, normalizeCurriculumEntries } = require('../services/curriculum');

// GET /teachers — all teachers with their teaches[] from user_preferences,
// ported from the monolith's routes/admin.js GET /teachers.
router.get('/', async (_req, res) => {
  try {
    const { data: teachers, error } = await supabase
      .from('users').select('id, name, email, school, curriculum').eq('role', 'teacher').order('name');
    if (error) return res.status(500).json({ error: error.message });

    const emails = (teachers || []).map((t) => t.email).filter(Boolean);
    const { data: prefs } = await supabase.from('user_preferences').select('user_email, data').in('user_email', emails);

    const prefMap = {};
    for (const p of prefs || []) prefMap[p.user_email] = p.data;

    res.json((teachers || []).map((t) => ({ ...t, curriculum: normalizeCurriculum(t.curriculum), teaches: normalizeCurriculumEntries(prefMap[t.email]?.teaches || []) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
