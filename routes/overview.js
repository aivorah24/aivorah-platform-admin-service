const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { normalizeCurriculum } = require('../services/curriculum');

// GET /overview — platform-wide stats for the Admin > Overview tab.
// Ported from the monolith's routes/admin.js (GET /panel's /admin/overview
// call), now pointed at the Test DB the live app actually runs on (the
// monolith route was still reading the unused Prod project). B2B/B2C split
// and the per-school drill-down are derived client-side from `students[]`
// here, same as the original static HTML panel did — no separate endpoint
// needed for that.
router.get('/', async (_req, res) => {
  try {
    const [usersRes, statsRes, parentLinksRes, teacherLinksRes, assignmentsRes] = await Promise.all([
      supabase.from('users').select('id, name, email, role, grade, curriculum, school, location, onboarding_complete'),
      supabase.from('student_stats').select('student_id, xp_points, level, current_streak, study_time_minutes, completed_topics, last_lesson, updated_at'),
      supabase.from('parent_children').select('parent_email, child_id'),
      supabase.from('teacher_student').select('teacher_id, student_id'),
      supabase.from('assignments').select('id, status'),
    ]);

    for (const r of [usersRes, statsRes, parentLinksRes, teacherLinksRes, assignmentsRes]) {
      if (r.error) return res.status(500).json({ error: r.error.message });
    }

    const users = usersRes.data ?? [];
    const studentStats = statsRes.data ?? [];
    const parentLinks = parentLinksRes.data ?? [];
    const teacherLinks = teacherLinksRes.data ?? [];
    const assignments = assignmentsRes.data ?? [];

    const statsByStudentId = {};
    for (const s of studentStats) statsByStudentId[s.student_id] = s;

    const parentCountByChild = {};
    for (const link of parentLinks) parentCountByChild[link.child_id] = (parentCountByChild[link.child_id] || 0) + 1;

    const teacherCountByStudent = {};
    for (const link of teacherLinks) teacherCountByStudent[link.student_id] = (teacherCountByStudent[link.student_id] || 0) + 1;

    const students = users.filter((u) => u.role === 'student').map((u) => {
      const stats = statsByStudentId[u.id] ?? {};
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        grade: u.grade,
        curriculum: normalizeCurriculum(u.curriculum),
        school: u.school || '',
        location: u.location,
        onboardingComplete: u.onboarding_complete,
        xpPoints: stats.xp_points ?? 0,
        level: stats.level ?? 1,
        currentStreak: stats.current_streak ?? 0,
        studyTimeMinutes: stats.study_time_minutes ?? 0,
        completedTopicsCount: Array.isArray(stats.completed_topics) ? stats.completed_topics.length : 0,
        hasParent: !!parentCountByChild[u.id],
        teacherCount: teacherCountByStudent[u.id] ?? 0,
        lastSeen: stats.updated_at ?? null,
      };
    });

    const teachers = users.filter((u) => u.role === 'teacher').map((u) => ({
      id: u.id, name: u.name, email: u.email, school: u.school || '', location: u.location,
    }));

    const parents = users.filter((u) => u.role === 'parent').map((u) => ({
      id: u.id, name: u.name, email: u.email, school: u.school || '', location: u.location,
    }));

    const totalXP = students.reduce((sum, s) => sum + (s.xpPoints || 0), 0);

    res.json({
      counts: {
        users: users.length,
        students: students.length,
        teachers: teachers.length,
        parents: parents.length,
        totalXP,
        assignments: assignments.length,
        assignmentsCompleted: assignments.filter((a) => a.status === 'completed').length,
      },
      students,
      teachers,
      parents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
