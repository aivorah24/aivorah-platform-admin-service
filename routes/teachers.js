const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { normalizeCurriculum, normalizeCurriculumEntries } = require('../services/curriculum');
const { importTeachers } = require('../services/teacherImport');

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

// POST /teachers/bulk-import — { schoolId, fileName, rows: [{ teacherName, email, phone, curriculum, grade, subjects }] }
router.post('/bulk-import', async (req, res) => {
  const { schoolId, rows, fileName } = req.body || {};
  if (!schoolId) return res.status(400).json({ error: 'schoolId is required' });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows must be a non-empty array' });
  if (rows.length > 500) return res.status(400).json({ error: 'At most 500 rows per import' });
  try {
    res.json(await importTeachers({ schoolId, rows, fileName, runByEmail: req.adminEmail }));
  } catch (err) {
    console.error('[POST /teachers/bulk-import] error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to import teachers' });
  }
});

module.exports = router;
