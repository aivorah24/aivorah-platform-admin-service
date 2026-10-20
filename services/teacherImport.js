// Spreadsheet teacher import for platform admins — ported from
// aivorah-school-admin-service POST /school-admin/teachers/bulk, but for any
// school (chosen per batch). Each row is isolated: a failing row is reported
// in `errors` and never aborts the batch.
const { randomUUID } = require('crypto');
const supabase = require('./supabase');
const { generateSecurePassword, createFirebaseAccount, toTitleCase } = require('./studentAccounts');
const { sendOwnAccountCredentialsEmail } = require('./mailer');
const { resolveCurriculum } = require('./bulkImport');
const { normalizeCurriculum } = require('./curriculum');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Teachers without an email get a typeable, clearly-generated login.
function generateTeacherLogin(name, school) {
  const slug = String(name || 'teacher').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.').slice(0, 30) || 'teacher';
  const schoolSlug = String(school || 'school').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'school';
  return `${slug}.${Date.now().toString(36)}@${schoolSlug}.teacher`;
}

// "Grade 1 | Grade 3" + "Maths | Science; English" → one teaches[] entry per grade, matched by position.
function parseTeaches(rowCurriculum, rowGrade, rowSubjects, schoolBoard) {
  const grades = String(rowGrade || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!grades.length) return { entries: [], error: null };
  const curricula = String(rowCurriculum || '').split('|').map((s) => s.trim()).filter(Boolean);
  const subjectGroups = String(rowSubjects || '').split('|').map((s) => s.trim());
  if (grades.length > 1 && subjectGroups.length > 1 && subjectGroups.length !== grades.length) {
    return { entries: [], error: `Grade has ${grades.length} "|" groups but Subjects has ${subjectGroups.length} — they must match one-to-one` };
  }
  const entries = grades.map((grade, i) => {
    const curriculum = normalizeCurriculum(resolveCurriculum(schoolBoard, grade) || curricula[i] || curricula[0] || '');
    const group = subjectGroups.length > 1 ? subjectGroups[i] : subjectGroups[0];
    const subjects = String(group || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    return { curriculum, grade, subjects };
  }).filter((e) => e.grade);
  return { entries, error: null };
}

async function logImportRun({ schoolId, fileName, runByEmail, importedCount, skippedCount }) {
  const status = skippedCount === 0 ? 'Completed' : (importedCount > 0 ? 'Completed with errors' : 'Failed');
  try {
    await supabase.from('import_runs').insert({
      school_id: schoolId, type: 'teachers', file_name: fileName || 'import.csv', run_by_email: runByEmail,
      imported_count: importedCount, skipped_count: skippedCount, status,
    });
  } catch (err) {
    console.error('[teacherImport] failed to record import run:', err.message);
  }
}

async function importTeachers({ schoolId, rows, fileName, runByEmail }) {
  const { data: school, error: schoolErr } = await supabase.from('schools').select('id, name, curriculum').eq('id', schoolId).maybeSingle();
  if (schoolErr) throw schoolErr;
  if (!school) { const e = new Error('School not found'); e.status = 404; throw e; }
  const schoolName = school.name;
  const errors = [];
  const skipped = [];
  const records = [];
  const byEmail = new Map(); // same-email rows merge into one account

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const rowNum = i + 1;
    try {
      const teacherName = String(raw.teacherName || '').trim();
      const emailIn = String(raw.email || '').trim().toLowerCase();
      const phone = String(raw.phone || '').trim();
      if (!teacherName) { errors.push({ row: rowNum, error: 'Teacher Name is required' }); continue; }
      if (emailIn && !EMAIL_RE.test(emailIn)) { errors.push({ row: rowNum, error: `"${emailIn}" is not a valid email` }); continue; }
      const { entries, error: groupError } = parseTeaches(raw.curriculum, raw.grade, raw.subjects, school.curriculum);
      if (groupError) { errors.push({ row: rowNum, error: groupError }); continue; }

      if (emailIn && byEmail.has(emailIn)) { byEmail.get(emailIn).teaches.push(...entries); continue; }

      const name = toTitleCase(teacherName);
      if (emailIn) {
        const { data: dup } = await supabase.from('users').select('id, role').eq('email', emailIn).maybeSingle();
        if (dup) { skipped.push({ row: rowNum, name, email: emailIn, reason: dup.role === 'teacher' ? 'Teacher already exists' : `Email already used by a ${dup.role} account` }); continue; }
      }
      const email = emailIn || generateTeacherLogin(name, schoolName);
      const password = generateSecurePassword();
      const firebaseUid = await createFirebaseAccount(email, password);
      const userId = randomUUID();
      const { error: userErr } = await supabase.from('users').insert({
        id: userId, name, email, role: 'teacher', phone: phone || null,
        school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
        curriculum: entries[0]?.curriculum || null, grade: entries[0]?.grade || null,
      });
      if (userErr) throw userErr;
      const rec = { name, email, password, firebaseUid, teaches: [...entries], realEmail: !!emailIn };
      records.push(rec);
      if (emailIn) byEmail.set(emailIn, rec);
    } catch (rowErr) {
      console.error(`[teacherImport] row ${rowNum} error:`, rowErr.message);
      errors.push({ row: rowNum, error: rowErr.message });
    }
  }

  const credentials = [];
  const mails = [];
  for (const rec of records) {
    const teachCurriculum = rec.teaches[0]?.curriculum || null;
    const teachGrade = rec.teaches[0]?.grade || null;
    await supabase.from('user_preferences').upsert({
      user_email: rec.email,
      data: {
        loginId: rec.email, initialPassword: rec.password, teacherName: rec.name, school: schoolName, firebaseUid: rec.firebaseUid,
        teaches: rec.teaches, teachCurriculum, teachGrade, mustChangePassword: true, accountStatus: 'active',
      },
    });
    const subjects = [...new Set(rec.teaches.flatMap((e) => e.subjects))];
    credentials.push({ name: rec.name, email: rec.email, password: rec.password, role: 'teacher', grade: rec.teaches.map((e) => e.grade).join(', '), subjects });
    if (rec.realEmail) mails.push({ to: rec.email, name: rec.name, loginId: rec.email, password: rec.password, role: 'teacher' });
  }

  // Accounts already exist by now — a mail failure must not fail the import.
  Promise.allSettled(mails.map((m) => sendOwnAccountCredentialsEmail(m).catch((err) => console.warn('[teacherImport] email failed:', err.message))));

  await logImportRun({ schoolId, fileName, runByEmail, importedCount: records.length, skippedCount: skipped.length + errors.length });
  return { school: schoolName, created: records.length, skipped, errors, credentials };
}

module.exports = { importTeachers, parseTeaches, generateTeacherLogin };
