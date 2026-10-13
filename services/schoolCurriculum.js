// A school's board (schools.curriculum). Set once by an admin — from Bulk Import when
// it's still null, or explicitly via PATCH /schools/:id — and audit-logged.
const supabase = require('./supabase');
const { audit } = require('./adminUsers');

const SCHOOL_BOARDS = ['IB', 'CBSE', 'ICSE', 'Cambridge'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Canonical board name, or null if not one of SCHOOL_BOARDS.
function normalizeBoard(value) {
  const v = String(value || '').trim().toLowerCase();
  return SCHOOL_BOARDS.find((b) => b.toLowerCase() === v) || null;
}

async function setSchoolCurriculum(school, curriculum, adminEmail) {
  const board = normalizeBoard(curriculum);
  if (!board) throw httpError(400, `curriculum must be one of ${SCHOOL_BOARDS.join(', ')}`);
  const from = school.curriculum || null;
  const { error } = await supabase.from('schools').update({ curriculum: board }).eq('id', school.id);
  if (error) throw error;
  await audit(adminEmail, 'school.set_curriculum', { id: school.id }, { school: school.name, from, to: board });
  return { ...school, curriculum: board };
}

// Import path: a client curriculum only fills a school that has none; otherwise it's ignored.
async function ensureSchoolCurriculum(school, curriculum, adminEmail) {
  if (school.curriculum) return school;
  if (!curriculum) throw httpError(400, `${school.name} has no curriculum set — choose one (${SCHOOL_BOARDS.join(', ')})`);
  return setSchoolCurriculum(school, curriculum, adminEmail);
}

module.exports = { SCHOOL_BOARDS, normalizeBoard, setSchoolCurriculum, ensureSchoolCurriculum };
