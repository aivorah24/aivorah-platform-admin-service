// Spreadsheet student import for platform admins — ported from
// aivorah-school-admin-service POST /school-admin/students/bulk, but for any
// school (chosen per batch) instead of the caller's own. Each row is isolated:
// a failing row is reported in `errors` and never aborts the batch.
const { randomUUID } = require('crypto');
const supabase = require('./supabase');
const {
  generateSecurePassword, generateStudentEmail, createFirebaseAccount, toTitleCase, generateAdmissionNumber,
} = require('./studentAccounts');
const { generateParentLoginId } = require('./parentAccounts');
const { buildGradesSectionsView } = require('./academicStructure');
const { sendCredentialsEmail, sendOwnAccountCredentialsEmail } = require('./mailer');
const { ensureSchoolCurriculum } = require('./schoolCurriculum');

// A school follows one board; a student's curriculum is always derived from it
// (IB → PYP/MYP/DP by grade), never taken from the client.
function resolveCurriculum(baseCurriculum, grade) {
  const base = String(baseCurriculum || '').trim();
  if (!base) return null;
  if (!/^ib$/i.test(base)) return base;
  const num = parseInt(String(grade || '').replace(/\D/g, ''), 10);
  if (!num || num <= 5) return 'IB PYP';
  if (num <= 10) return 'IB MYP';
  return 'IB DP';
}

// Account is already created by the time we email — a mail failure must not turn the row into an error.
async function safeSend(fn, args) {
  try { await fn(args); } catch (err) { console.warn('[bulkImport] credentials email failed:', err.message); }
}

async function classTeacherMap(schoolId) {
  const map = new Map();
  try {
    const grades = await buildGradesSectionsView(schoolId);
    const emails = new Set();
    grades.forEach((g) => (g.sections || []).forEach((s) => { if (s.classTeacherEmail) emails.add(s.classTeacherEmail); }));
    if (!emails.size) return map;
    const { data: teachers } = await supabase.from('users')
      .select('id, email').in('email', [...emails]).eq('role', 'teacher').eq('school_id', schoolId);
    const idByEmail = new Map((teachers || []).map((t) => [t.email, t.id]));
    grades.forEach((g) => (g.sections || []).forEach((s) => {
      const id = s.classTeacherEmail ? idByEmail.get(s.classTeacherEmail) : null;
      if (id) map.set(`${g.name}||${s.name}`, id);
    }));
  } catch (err) {
    console.error('[bulkImport] class-teacher preload failed:', err.message);
  }
  return map;
}

async function logImportRun({ schoolId, fileName, runByEmail, importedCount, skippedCount }) {
  const status = skippedCount === 0 ? 'Completed' : (importedCount > 0 ? 'Completed with errors' : 'Failed');
  try {
    await supabase.from('import_runs').insert({
      school_id: schoolId, type: 'students', file_name: fileName || 'import.csv', run_by_email: runByEmail,
      imported_count: importedCount, skipped_count: skippedCount, status,
    });
  } catch (err) {
    console.error('[bulkImport] failed to record import run:', err.message);
  }
}

// `curriculum` is only used (and saved to the school) when the school has none yet.
async function importStudents({ schoolId, rows, fileName, runByEmail, curriculum }) {
  const { data: found, error: schoolErr } = await supabase.from('schools').select('id, name, curriculum').eq('id', schoolId).maybeSingle();
  if (schoolErr) throw schoolErr;
  if (!found) { const e = new Error('School not found'); e.status = 404; throw e; }
  const school = await ensureSchoolCurriculum(found, curriculum, runByEmail);
  const schoolName = school.name;

  const { count } = await supabase.from('users')
    .select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'student');
  let studentCount = count || 0;

  const created = []; const skipped = []; const errors = []; const credentials = [];
  const classTeacherIds = await classTeacherMap(schoolId);

  const mails = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const studentName = String(raw.studentName || '').trim();
    const studentEmail = String(raw.studentEmail || '').trim().toLowerCase();
    const admissionNo = String(raw.admissionNo || '').trim();
    const grade = String(raw.grade || '').trim();
    const section = String(raw.section || '').trim();
    const parentName = String(raw.parentName || '').trim();
    const parentEmailIn = String(raw.parentEmail || '').trim().toLowerCase();
    const parentPhone = String(raw.parentPhone || '').trim();

    try {
      if (!studentName) { errors.push({ row: i + 1, error: 'Student Name is required' }); continue; }
      const name = toTitleCase(studentName);

      let existing = null;
      if (studentEmail) {
        ({ data: existing } = await supabase.from('users').select('id, email')
          .eq('email', studentEmail).eq('school_id', schoolId).eq('role', 'student').maybeSingle());
      }
      if (!existing && admissionNo) {
        ({ data: existing } = await supabase.from('users').select('id, email')
          .eq('admission_number', admissionNo).eq('school_id', schoolId).eq('role', 'student').maybeSingle());
      }
      if (existing) { skipped.push({ row: i + 1, name, email: existing.email, reason: 'Student already exists' }); continue; }

      const email = studentEmail || generateStudentEmail(name, schoolName);
      const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
      if (dup) { errors.push({ row: i + 1, error: 'Email already exists' }); continue; }
      // Check the parent email before creating anything so a clash doesn't leave a half-imported row.
      if (parentName && parentEmailIn) {
        const { data: clash } = await supabase.from('users').select('role').eq('email', parentEmailIn).maybeSingle();
        if (clash && clash.role !== 'parent') {
          errors.push({ row: i + 1, error: `Parent email ${parentEmailIn} already belongs to a non-parent account` });
          continue;
        }
      }

      const password = generateSecurePassword();
      const firebaseUid = await createFirebaseAccount(email, password);
      const studentId = randomUUID();
      const { error: userErr } = await supabase.from('users').insert({
        id: studentId, name, email, role: 'student',
        grade: grade || null, section: section || null, school: schoolName, school_id: schoolId,
        curriculum: resolveCurriculum(school.curriculum, grade),
        admission_number: admissionNo || generateAdmissionNumber(schoolName, studentCount++),
        status: 'active', onboarding_complete: true,
      });
      if (userErr) throw userErr;
      await supabase.from('student_stats').insert({ student_id: studentId });
      await supabase.from('user_preferences').upsert({
        user_email: email,
        data: { loginId: email, initialPassword: password, studentName: name, grade: grade || null, section: section || null, school: schoolName, firebaseUid, mustChangePassword: true, accountStatus: 'active' },
      });
      created.push({ id: studentId, name, email, grade, section });
      credentials.push({ name, email, password, role: 'student', grade, section });

      const classTeacherId = grade && section ? classTeacherIds.get(`${grade}||${section}`) : null;
      if (classTeacherId) {
        await supabase.from('teacher_student')
          .upsert({ teacher_id: classTeacherId, student_id: studentId, subject: 'Homeroom' },
            { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });
      }

      let linkedParentEmail = '';
      if (parentName) {
        let parentEmail = parentEmailIn;
        let parentExists = false;
        if (parentEmail) {
          const { data: p } = await supabase.from('users').select('id, role, phone').eq('email', parentEmail).maybeSingle();
          if (p && p.role !== 'parent') throw new Error(`Parent email ${parentEmail} already belongs to a non-parent account`);
          if (p) {
            parentExists = true;
            if (parentPhone && parentPhone !== p.phone) await supabase.from('users').update({ phone: parentPhone }).eq('id', p.id);
          }
        }
        if (!parentExists) {
          if (!parentEmail) parentEmail = await generateParentLoginId();
          const pName = toTitleCase(parentName);
          const pPassword = generateSecurePassword();
          const pUid = await createFirebaseAccount(parentEmail, pPassword);
          const { error: pErr } = await supabase.from('users').insert({
            id: randomUUID(), name: pName, email: parentEmail, role: 'parent',
            phone: parentPhone || null, school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
          });
          if (pErr) throw pErr;
          await supabase.from('user_preferences').upsert({
            user_email: parentEmail,
            data: { loginId: parentEmail, initialPassword: pPassword, parentName: pName, school: schoolName, firebaseUid: pUid, mustChangePassword: true, accountStatus: 'active' },
          });
          credentials.push({ name: pName, email: parentEmail, password: pPassword, role: 'parent' });
          if (parentEmailIn) mails.push([sendOwnAccountCredentialsEmail, { to: parentEmail, name: pName, loginId: parentEmail, password: pPassword, role: 'parent' }]);
        }
        const { data: link } = await supabase.from('parent_children').select('child_id').eq('parent_email', parentEmail).eq('child_id', studentId).maybeSingle();
        if (!link) await supabase.from('parent_children').insert({ parent_email: parentEmail, child_id: studentId });
        if (parentEmailIn) linkedParentEmail = parentEmail;
      }

      const mailTo = studentEmail || linkedParentEmail;
      if (mailTo) mails.push([sendCredentialsEmail, { to: mailTo, childName: name, loginId: email, password, childEmail: email }]);
    } catch (rowErr) {
      console.error(`[bulkImport] row ${i + 1} error:`, rowErr.message);
      errors.push({ row: i + 1, error: rowErr.message });
    }
  }

  // Emails go out in parallel after the response instead of blocking each row.
  Promise.allSettled(mails.map(([fn, args]) => safeSend(fn, args)));

  await logImportRun({ schoolId, fileName, runByEmail, importedCount: created.length, skippedCount: skipped.length + errors.length });
  return { school: schoolName, created: created.length, students: created, skipped, errors, credentials };
}

module.exports = { importStudents, resolveCurriculum };
