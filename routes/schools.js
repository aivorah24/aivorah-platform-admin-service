const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

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

module.exports = router;
