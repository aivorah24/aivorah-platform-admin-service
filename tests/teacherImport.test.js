// importTeachers against a tiny in-memory stand-in for the Supabase query builder.
const mockDb = { users: [], schools: [], import_runs: [], user_preferences: [] };

function mockQuery(table) {
  const filters = [];
  let pending = null;
  const q = {
    select: () => q,
    eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
    insert: (row) => { pending = { op: 'insert', row }; return q; },
    upsert: (row) => { pending = { op: 'upsert', row }; return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    then: (resolve) => resolve(run()),
  };
  const rows = () => mockDb[table].filter((r) => filters.every((f) => f(r)));
  function run() {
    if (pending) { [].concat(pending.row).forEach((r) => mockDb[table].push({ ...r })); return { data: null, error: null }; }
    return { data: rows(), error: null };
  }
  return q;
}

jest.mock('../services/supabase', () => ({ from: (t) => mockQuery(t) }));
jest.mock('../services/studentAccounts', () => ({
  ...jest.requireActual('../services/studentAccounts'),
  createFirebaseAccount: jest.fn(async () => 'uid'),
  generateSecurePassword: () => 'Pw!12345',
}));
jest.mock('../services/academicStructure', () => ({ buildGradesSectionsView: jest.fn(async () => []) }));
jest.mock('../services/mailer', () => ({ sendCredentialsEmail: jest.fn(), sendOwnAccountCredentialsEmail: jest.fn(async () => {}) }));

const mailer = require('../services/mailer');
const { importTeachers, parseTeaches } = require('../services/teacherImport');

beforeEach(() => {
  Object.keys(mockDb).forEach((k) => { mockDb[k] = []; });
  mockDb.schools.push({ id: 'sch1', name: 'TSRA', curriculum: 'IB' });
  jest.clearAllMocks();
});

test('creates teachers with the sheet email as login, or a generated one, and returns credentials', async () => {
  const out = await importTeachers({
    schoolId: 'sch1', fileName: 't.xlsx', runByEmail: 'admin@aivorah.ai',
    rows: [
      { teacherName: 'priya rao', email: 'Priya@Real.com', phone: '9000000001', grade: 'Grade 3 | Grade 7', subjects: 'Maths | Science; English' },
      { teacherName: 'Rahul Sen', grade: 'Grade 11', subjects: 'Physics' },
    ],
  });
  expect(out.created).toBe(2);
  expect(out.credentials[0]).toMatchObject({ name: 'Priya Rao', email: 'priya@real.com', password: 'Pw!12345', role: 'teacher' });
  expect(out.credentials[1].email).toMatch(/^rahul\.sen\..+@tsra\.teacher$/);
  const priya = mockDb.users.find((u) => u.email === 'priya@real.com');
  expect(priya).toMatchObject({ role: 'teacher', school: 'TSRA', school_id: 'sch1', phone: '9000000001', curriculum: 'IB PYP', grade: 'Grade 3' });
  const prefs = mockDb.user_preferences.find((p) => p.user_email === 'priya@real.com').data;
  expect(prefs.teaches).toEqual([
    { curriculum: 'IB PYP', grade: 'Grade 3', subjects: ['Maths'] },
    { curriculum: 'IB MYP', grade: 'Grade 7', subjects: ['Science', 'English'] },
  ]);
  expect(mailer.sendOwnAccountCredentialsEmail).toHaveBeenCalledTimes(1);
  expect(mockDb.import_runs[0]).toMatchObject({ type: 'teachers', imported_count: 2 });
});

test('same email on two rows merges into one teacher', async () => {
  const out = await importTeachers({
    schoolId: 'sch1',
    rows: [
      { teacherName: 'Priya', email: 'p@real.com', grade: 'Grade 3', subjects: 'Maths' },
      { teacherName: 'Priya', email: 'p@real.com', grade: 'Grade 4', subjects: 'Science' },
    ],
  });
  expect(out.created).toBe(1);
  expect(mockDb.user_preferences[0].data.teaches.map((e) => e.grade)).toEqual(['Grade 3', 'Grade 4']);
});

test('existing accounts are skipped; bad rows are errors and never abort the batch', async () => {
  mockDb.users.push({ id: 'x', email: 'old@real.com', role: 'teacher' }, { id: 'y', email: 'kid@real.com', role: 'student' });
  const out = await importTeachers({
    schoolId: 'sch1',
    rows: [
      { teacherName: 'Old', email: 'old@real.com' },
      { teacherName: 'Kid', email: 'kid@real.com' },
      { teacherName: '' },
      { teacherName: 'Bad', email: 'not-an-email' },
      { teacherName: 'New One' },
    ],
  });
  expect(out.created).toBe(1);
  expect(out.skipped.map((s) => s.reason)).toEqual(['Teacher already exists', 'Email already used by a student account']);
  expect(out.errors.map((e) => e.row)).toEqual([3, 4]);
});

test('unknown school is a 404', async () => {
  await expect(importTeachers({ schoolId: 'nope', rows: [{ teacherName: 'A' }] })).rejects.toMatchObject({ status: 404 });
});

test('parseTeaches flags mismatched grade/subject groups', () => {
  expect(parseTeaches('', 'Grade 1 | Grade 2 | Grade 3', 'Maths | Science', 'CBSE').error).toMatch(/must match/);
  expect(parseTeaches('', 'Grade 1 | Grade 2', 'Maths', 'CBSE').entries).toEqual([
    { curriculum: 'CBSE', grade: 'Grade 1', subjects: ['Maths'] },
    { curriculum: 'CBSE', grade: 'Grade 2', subjects: ['Maths'] },
  ]);
});
