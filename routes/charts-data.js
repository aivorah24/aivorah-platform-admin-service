const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { normalizeCurriculum } = require('../services/curriculum');

// GET /charts-data — aggregate breakdowns for the Admin > Overview charts
// section. Ported from the monolith's routes/admin.js GET /charts-data onto
// the Test DB this service runs on (same shape; the panel's role/curriculum/
// grade/assignment distributions and the 7-day assignment trend).
router.get('/', async (_req, res) => {
  try {
    const [usersRes, statsRes, assignmentsRes] = await Promise.all([
      supabase.from('users').select('id, role, grade, curriculum, onboarding_complete'),
      supabase.from('student_stats').select('student_id, xp_points, study_time_minutes, current_streak, completed_topics'),
      supabase.from('assignments').select('id, status, curriculum, grade, created_at, type'),
    ]);

    for (const r of [usersRes, statsRes, assignmentsRes]) {
      if (r.error) return res.status(500).json({ error: r.error.message });
    }

    const users = usersRes.data ?? [];
    const stats = statsRes.data ?? [];
    const assignments = assignmentsRes.data ?? [];

    const roleCounts = { student: 0, teacher: 0, parent: 0 };
    for (const u of users) if (roleCounts[u.role] !== undefined) roleCounts[u.role]++;

    const normCurriculum = (c) => {
      if (!c) return null;
      const s = String(c).trim().toUpperCase().replace(/[_-]/g, ' ');
      if (s === 'IB PYP') return 'IB PYP';
      return normalizeCurriculum(c);
    };
    const curriculumMap = {};
    for (const u of users.filter((u) => u.role === 'student')) {
      const c = normCurriculum(u.curriculum);
      if (!c) continue;
      curriculumMap[c] = (curriculumMap[c] || 0) + 1;
    }

    const gradeMap = {};
    for (const u of users.filter((u) => u.role === 'student')) {
      const g = u.grade || 'Unknown';
      gradeMap[g] = (gradeMap[g] || 0) + 1;
    }

    const onboarding = { student: { done: 0, total: 0 }, teacher: { done: 0, total: 0 }, parent: { done: 0, total: 0 } };
    for (const u of users) {
      if (onboarding[u.role]) {
        onboarding[u.role].total++;
        if (u.onboarding_complete) onboarding[u.role].done++;
      }
    }

    const topXP = stats
      .slice()
      .sort((a, b) => (b.xp_points || 0) - (a.xp_points || 0))
      .slice(0, 8)
      .map((s) => ({ id: s.student_id, xp: s.xp_points || 0, studyTime: s.study_time_minutes || 0, streak: s.current_streak || 0 }));

    const assignmentStats = {
      total: assignments.length,
      completed: assignments.filter((a) => a.status === 'completed').length,
      pending: assignments.filter((a) => a.status === 'pending').length,
      byType: {},
    };
    for (const a of assignments) {
      assignmentStats.byType[a.type] = (assignmentStats.byType[a.type] || 0) + 1;
    }

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const count = assignments.filter((a) => (a.created_at || '').startsWith(dateStr)).length;
      last7.push({ date: dateStr.slice(5), count });
    }

    res.json({ roleCounts, curriculumMap, gradeMap, onboarding, topXP, assignmentStats, assignmentsLast7: last7 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
