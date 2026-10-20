// importStudents against a tiny in-memory stand-in for the Supabase query builder.
const mockDb = { users: [], schools: [], parent_children: [], import_runs: [], student_stats: [], user_preferences: [], teacher_student: [], analytics_events: [] };

function mockQuery(table) {
  const filters = [];
  let pending = null; // insert/update/upsert payload
  const q = {
    select: () => q,
    eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
    in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return q; },
    insert: (row) => { pending = { op: 'insert', row }; return q; },
    upsert: (row) => { pending = { op: 'upsert', row }; return q; },
    update: (patch) => { pending = { op: 'update', patch }; return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    then: (resolve) => resolve(run()),
  };
  const rows = () => mockDb[table].filter((r) => filters.every((f) => f(r)));
  function run() {
    if (pending?.op === 'insert' || pending?.op === 'upsert') { [].concat(pending.row).forEach((r) => mockDb[table].push({ ...r })); return { data: null, error: null }; }
    if (pending?.op === 'update') { rows().forEach((r) => Object.assign(r, pending.patch)); return { data: null, error: null }; }
    return { data: rows(), error: null, count: rows().length };
  }
  return q;
}

jest.mock('../services/supabase', () => ({ from: (t) => mockQuery(t) }));
jest.mock('../services/studentAccounts', () => ({
  ...jest.requireActual('../services/studentAccounts'),
  createFirebaseAccount: jest.fn(async () => 'uid'),
  generateSecurePassword: () => 'Pw!12345',
}));
jest.mock('../services/academicStructure', () => ({
  buildGradesSectionsView: jest.fn(async () => [{ name: 'Grade 4', sections: [{ name: 'A', classTeacherEmail: 'ct@s.test' }] }]),
}));
jest.mock('../services/mailer', () => ({
  sendCredentialsEmail: jest.fn(async () => { throw new Error('smtp down'); }),
  sendOwnAccountCredentialsEmail: jest.fn(async () => {}),
}));
jest.mock('../services/parentAccounts', () => ({ generateParentLoginId: jest.fn(async () => 'p1@aivorah.parent') }));

const { importStudents, resolveCurriculum } = require('../services/bulkImport');

beforeEach(() => {
  Object.keys(mockDb).forEach((k) => { mockDb[k] = []; });
  mockDb.schools.push({ id: 'sch1', name: 'TSRA', curriculum: 'IB' });
  mockDb.users.push({ id: 'ct1', email: 'ct@s.test', role: 'teacher', school_id: 'sch1' });
  mockDb.users.push({ id: 'old', email: 'taken@s.test', role: 'student', school_id: 'sch1' });
});

test('creates students with IB curriculum from grade, links the class teacher, and returns logins', async () => {
  const out = await importStudents({
    schoolId: 'sch1', runByEmail: 'admin@aivorah.ai', fileName: 'g4.xlsx',
    rows: [{ studentName: 'asha rao', grade: 'Grade 4', section: 'A' }, { studentName: 'ben', grade: 'Grade 7' }],
  });
  expect(out.created).toBe(2);
  const asha = mockDb.users.find((u) => u.name === 'Asha Rao');
  expect(asha).toMatchObject({ role: 'student', school: 'TSRA', school_id: 'sch1', curriculum: 'IB PYP', grade: 'Grade 4', section: 'A' });
  expect(mockDb.users.find((u) => u.name === 'Ben').curriculum).toBe('IB MYP');
  expect(mockDb.teacher_student).toEqual([expect.objectContaining({ teacher_id: 'ct1', student_id: asha.id, subject: 'Homeroom' })]);
  expect(out.credentials.map((c) => c.role)).toEqual(['student', 'student']);
  expect(mockDb.import_runs[0]).toMatchObject({ school_id: 'sch1', imported_count: 2, skipped_count: 0, status: 'Completed', run_by_email: 'admin@aivorah.ai' });
});

test("a row's curriculum is ignored — every student gets the school's (IB by grade, other boards as-is)", async () => {
  await importStudents({
    schoolId: 'sch1',
    rows: [{ studentName: 'Ivy', grade: 'Grade 3', curriculum: 'CBSE' }, { studentName: 'Jay', grade: 'Grade 11', curriculum: 'IB PYP' }],
  });
  expect(mockDb.users.find((u) => u.name === 'Ivy').curriculum).toBe('IB PYP');
  expect(mockDb.users.find((u) => u.name === 'Jay').curriculum).toBe('IB DP');

  mockDb.schools.push({ id: 'sch2', name: 'Seed', curriculum: 'ICSE' });
  await importStudents({ schoolId: 'sch2', rows: [{ studentName: 'Kim', grade: 'Grade 4', curriculum: 'IB PYP' }] });
  expect(mockDb.users.find((u) => u.name === 'Kim').curriculum).toBe('ICSE');
});

describe('school with no curriculum', () => {
  beforeEach(() => { mockDb.schools.push({ id: 'blank', name: 'Blank', curriculum: null }); });

  test('a chosen curriculum is validated, saved to the school and audited before students are created', async () => {
    const out = await importStudents({ schoolId: 'blank', curriculum: 'ib', runByEmail: 'admin@aivorah.ai', rows: [{ studentName: 'Mia', grade: 'Grade 8' }] });
    expect(out.created).toBe(1);
    expect(mockDb.schools.find((s) => s.id === 'blank').curriculum).toBe('IB');
    expect(mockDb.users.find((u) => u.name === 'Mia').curriculum).toBe('IB MYP');
    expect(mockDb.analytics_events).toEqual([expect.objectContaining({
      event_type: 'admin_action', user_email: 'admin@aivorah.ai', page: 'school.set_curriculum',
      meta: expect.objectContaining({ targetId: 'blank', from: null, to: 'IB' }),
    })]);
  });

  test('a missing or invalid curriculum is a 400 and nothing is written', async () => {
    await expect(importStudents({ schoolId: 'blank', rows: [{ studentName: 'X' }] })).rejects.toMatchObject({ status: 400 });
    await expect(importStudents({ schoolId: 'blank', curriculum: 'State Board', rows: [{ studentName: 'X' }] })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.schools.find((s) => s.id === 'blank').curriculum).toBeNull();
    expect(mockDb.users.filter((u) => u.role === 'student')).toHaveLength(1);
    expect(mockDb.analytics_events).toEqual([]);
  });
});

test("a client curriculum is ignored when the school already has one", async () => {
  await importStudents({ schoolId: 'sch1', curriculum: 'CBSE', rows: [{ studentName: 'Ned', grade: 'Grade 2' }] });
  expect(mockDb.schools.find((s) => s.id === 'sch1').curriculum).toBe('IB');
  expect(mockDb.users.find((u) => u.name === 'Ned').curriculum).toBe('IB PYP');
  expect(mockDb.analytics_events).toEqual([]);
});

test('per-row problems are reported without aborting the batch, and a failed email does not fail the row', async () => {
  const out = await importStudents({
    schoolId: 'sch1',
    rows: [
      { studentName: '' },
      { studentName: 'Dup', studentEmail: 'taken@s.test' },
      { studentName: 'Cara', studentEmail: 'cara@s.test', parentName: 'mona', parentPhone: '99' },
    ],
  });
  expect(out.errors).toEqual([{ row: 1, error: 'Student Name is required' }]);
  expect(out.skipped).toEqual([expect.objectContaining({ row: 2, reason: 'Student already exists' })]);
  expect(out.created).toBe(1);
  expect(mockDb.users.find((u) => u.email === 'p1@aivorah.parent')).toMatchObject({ role: 'parent', name: 'Mona', phone: '99', school: 'TSRA', school_id: 'sch1' });
  expect(mockDb.parent_children).toEqual([{ parent_email: 'p1@aivorah.parent', child_id: mockDb.users.find((u) => u.name === 'Cara').id }]);
  expect(mockDb.import_runs[0].status).toBe('Completed with errors');
});

test('an unknown school is a 404, not a partial import', async () => {
  await expect(importStudents({ schoolId: 'nope', rows: [{ studentName: 'X' }] })).rejects.toMatchObject({ status: 404 });
  expect(mockDb.users.filter((u) => u.role === 'student')).toHaveLength(1);
});

test('resolveCurriculum maps IB grades to PYP/MYP/DP and leaves other boards alone', () => {
  expect(['Grade 1', 'Grade 5', 'Grade 6', 'Grade 10', 'Grade 11'].map((g) => resolveCurriculum('IB', g)))
    .toEqual(['IB PYP', 'IB PYP', 'IB MYP', 'IB MYP', 'IB DP']);
  expect(resolveCurriculum('CBSE', 'Grade 9')).toBe('CBSE');
  expect(resolveCurriculum(' ib ', 'Grade 7')).toBe('IB MYP');
  expect(resolveCurriculum(null, 'Grade 9')).toBeNull();
});

test('a parent email owned by a non-parent fails the row before any account is created', async () => {
  const out = await importStudents({
    schoolId: 'sch1',
    rows: [{ studentName: 'Kiara', studentEmail: 'kiara@s.test', parentName: 'Meera', parentEmail: 'ct@s.test' }],
  });
  expect(out.errors).toEqual([{ row: 1, error: 'Parent email ct@s.test already belongs to a non-parent account' }]);
  expect(out.created).toBe(0);
  expect(out.credentials).toEqual([]);
  expect(mockDb.users.find((u) => u.email === 'kiara@s.test')).toBeUndefined();
});
