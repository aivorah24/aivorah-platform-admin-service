const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { buildGradesSectionsView } = require('../services/academicStructure');
const { setSchoolCurriculum } = require('../services/schoolCurriculum');

// GET /schools — each school's name and board (schools.curriculum, e.g. "IB", "CBSE"),
// so the admin filters can offer only the curricula a school actually runs.
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('schools').select('id, name, curriculum').order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map((s) => ({ id: s.id, name: s.name, curriculum: s.curriculum || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /schools/:id/structure — grades with their sections, for the admin edit-user form.
router.get('/:id/structure', async (req, res) => {
  try {
    res.json({ grades: await buildGradesSectionsView(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /schools/:id — Body: { curriculum: 'IB'|'CBSE'|'ICSE'|'Cambridge' }. Audit-logged.
router.patch('/:id', async (req, res) => {
  try {
    const { data: school, error } = await supabase.from('schools').select('id, name, curriculum').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!school) return res.status(404).json({ error: 'School not found' });
    const updated = await setSchoolCurriculum(school, (req.body || {}).curriculum, req.adminEmail);
    res.json({ id: updated.id, name: updated.name, curriculum: updated.curriculum });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
