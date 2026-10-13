const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const supabase = require('../services/supabase');
const { normalizeCurriculum } = require('../services/curriculum');
const { generateSecurePassword, generateStudentEmail, createFirebaseAccount, toTitleCase } = require('../services/studentAccounts');

// GET /students?grade=&section=&school=&unassigned=true — ported from the
// monolith's routes/admin.js GET /students, onto the Test DB.
router.get('/', async (req, res) => {
  try {
    const { grade, section, school, unassigned } = req.query;
    let query = supabase
      .from('users')
      .select('id, name, email, grade, curriculum, school, section, created_at, student_stats (xp_points, level, current_streak, study_time_minutes, topics_explored, last_active_date)')
      .eq('role', 'student')
      .order('created_at', { ascending: false });

    if (grade) query = query.eq('grade', grade);
    if (section) query = query.eq('section', section);
    if (school) query = query.ilike('school', `%${school}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const { data: tsData } = await supabase.from('teacher_student').select('student_id, teacher_id, subject');
    const { data: teacherUsers } = await supabase.from('users').select('id, name, email').eq('role', 'teacher');

    const teacherMap = {};
    for (const t of teacherUsers || []) teacherMap[t.id] = t;

    const tsByStudent = {};
    for (const ts of tsData || []) {
      if (!tsByStudent[ts.student_id]) tsByStudent[ts.student_id] = [];
      tsByStudent[ts.student_id].push({ teacher_id: ts.teacher_id, subject: ts.subject, teacher: teacherMap[ts.teacher_id] || null });
    }

    let students = (data || []).map((s) => ({ ...s, teacher_student: tsByStudent[s.id] || [] }));
    if (unassigned === 'true') students = students.filter((s) => s.teacher_student.length === 0);

    res.json({ students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /students/assign-teacher — Body: { studentIds: [uuid], teacherEmail, subject? }
router.post('/assign-teacher', async (req, res) => {
  try {
    const { studentIds, teacherEmail, subject } = req.body || {};
    if (!Array.isArray(studentIds) || !teacherEmail) return res.status(400).json({ error: 'studentIds and teacherEmail are required' });

    const { data: teacher } = await supabase.from('users').select('id').eq('email', teacherEmail.toLowerCase().trim()).maybeSingle();
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

    const resolvedSubject = subject || 'General';
    const rows = studentIds.map((sid) => ({ teacher_id: teacher.id, student_id: sid, subject: resolvedSubject }));
    const { error } = await supabase.from('teacher_student').upsert(rows, { onConflict: 'teacher_id,student_id,subject' });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, assigned: studentIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /students/bulk-create — Body: { students: [{name}|string], grade, section, school, curriculum, usePerRow }
router.post('/bulk-create', async (req, res) => {
  try {
    const { students, grade: defaultGrade, section: defaultSection, school, curriculum: defaultCurriculum, usePerRow } = req.body || {};
    if (!Array.isArray(students) || students.length === 0) return res.status(400).json({ error: 'students array is required' });

    const rows = students.map((s) => (typeof s === 'string' ? { name: s } : s));
    if (!usePerRow && !defaultGrade && !defaultCurriculum) return res.status(400).json({ error: 'grade and curriculum are required' });

    const created = [];
    const errors = [];

    for (const row of rows) {
      const name = toTitleCase(String(row.name || '').trim());
      if (!name) continue;
      const grade = row.grade || defaultGrade;
      const section = row.section || defaultSection || '';
      const curriculum = normalizeCurriculum(row.curriculum || defaultCurriculum);
      const rowSchool = row.school || school || '';
      if (!grade || !curriculum) { errors.push({ name, error: 'missing grade or curriculum' }); continue; }
      try {
        const email = generateStudentEmail(name, rowSchool);
        const password = generateSecurePassword();

        const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
        if (dup) { errors.push({ name, error: 'Email already exists' }); continue; }

        const firebaseUid = await createFirebaseAccount(email, password);
        const userId = randomUUID();

        const { error: userErr } = await supabase.from('users').insert({
          id: userId, name, email, role: 'student',
          grade, curriculum, school: rowSchool, section,
          onboarding_complete: true,
        });
        if (userErr) { errors.push({ name, error: userErr.message }); continue; }

        await supabase.from('student_stats').insert({ student_id: userId });
        await supabase.from('user_preferences').upsert({
          user_email: email,
          data: { loginId: email, initialPassword: password, studentName: name, grade, curriculum, section, school: rowSchool, firebaseUid },
        });

        created.push({ name, email, password, grade, curriculum, section, school: rowSchool });
      } catch (e) {
        errors.push({ name, error: e.message });
      }
    }

    res.json({ created, errors, total: created.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
