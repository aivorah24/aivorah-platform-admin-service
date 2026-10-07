// Real routes + requireAdmin through Supertest; Firebase and Supabase are
// mocked at the module boundary.
const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({
    verifyIdToken: jest.fn(async (token) => {
      if (token === 'bad') throw new Error('invalid');
      if (token === 'allowed') return { email: 'allowed@aivorah.test' };
      if (token === 'notallowed') return { email: 'nobody@elsewhere.test' };
      throw new Error('unexpected token');
    }),
  }),
}));

const USERS = [
  { id: 's1', name: 'Asha', email: 'asha@s.test', role: 'student', grade: 'Grade 5', curriculum: 'CBSE', school: 'TSRA', onboarding_complete: true },
  { id: 's2', name: 'Ben', email: 'ben@s.test', role: 'student', grade: 'Grade 6', curriculum: 'CBSE', school: '', onboarding_complete: true },
  { id: 't1', name: 'Ms Rao', email: 'rao@s.test', role: 'teacher', school: 'TSRA' },
  { id: 'p1', name: 'Mr Kumar', email: 'kumar@s.test', role: 'parent', school: '' },
];
const STATS = [
  { student_id: 's1', xp_points: 100, level: 2, current_streak: 3, study_time_minutes: 40, completed_topics: ['a', 'b'] },
  { student_id: 's2', xp_points: 50, level: 1, current_streak: 0, study_time_minutes: 10, completed_topics: [] },
];
const PARENT_LINKS = [{ parent_email: 'kumar@s.test', child_id: 's1' }];
const TEACHER_LINKS = [{ teacher_id: 't1', student_id: 's1' }];
const ASSIGNMENTS = [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'pending' }];

jest.mock('../services/supabase', () => ({
  from: jest.fn((table) => ({
    select: jest.fn(() => Promise.resolve({
      data: { users: USERS, student_stats: STATS, parent_children: PARENT_LINKS, teacher_student: TEACHER_LINKS, assignments: ASSIGNMENTS }[table],
      error: null,
    })),
  })),
}));

const app = require('../index');

describe('GET /overview', () => {
  test('rejects a request with no token', async () => {
    const res = await request(app).get('/overview');
    expect(res.status).toBe(401);
  });

  test('rejects a valid sign-in that is not on the admin allowlist', async () => {
    const res = await request(app).get('/overview').set('Authorization', 'Bearer notallowed');
    expect(res.status).toBe(403);
  });

  test('returns platform counts, per-student xp/school, and assignment totals for an allowed admin', async () => {
    const res = await request(app).get('/overview').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      users: 4, students: 2, teachers: 1, parents: 1,
      totalXP: 150, assignments: 2, assignmentsCompleted: 1,
    });
    const asha = res.body.students.find((s) => s.id === 's1');
    expect(asha).toMatchObject({ school: 'TSRA', xpPoints: 100, hasParent: true, teacherCount: 1 });
    const ben = res.body.students.find((s) => s.id === 's2');
    expect(ben).toMatchObject({ school: '', hasParent: false, teacherCount: 0 });
  });
});
