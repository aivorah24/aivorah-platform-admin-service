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

jest.mock('../services/supabase', () => ({
  from: jest.fn((table) => ({
    select: jest.fn(() => Promise.resolve({
      data: {
        users: [
          { id: 's1', role: 'student', grade: 'Grade 5', curriculum: 'CBSE', onboarding_complete: true },
          { id: 's2', role: 'student', grade: 'Grade 5', curriculum: 'ncert', onboarding_complete: false },
          { id: 't1', role: 'teacher', onboarding_complete: true },
          { id: 'p1', role: 'parent', onboarding_complete: true },
        ],
        student_stats: [
          { student_id: 's1', xp_points: 100, study_time_minutes: 40, current_streak: 3, completed_topics: ['a'] },
          { student_id: 's2', xp_points: 50, study_time_minutes: 10, current_streak: 0, completed_topics: [] },
        ],
        assignments: [
          { id: 'a1', status: 'completed', type: 'quiz', created_at: new Date().toISOString() },
          { id: 'a2', status: 'pending', type: 'worksheet', created_at: new Date().toISOString() },
        ],
      }[table],
      error: null,
    })),
  })),
}));

const app = require('../index');

describe('GET /charts-data', () => {
  test('rejects a request with no token', async () => {
    const res = await request(app).get('/charts-data');
    expect(res.status).toBe(401);
  });

  test('rejects a valid sign-in that is not on the admin allowlist', async () => {
    const res = await request(app).get('/charts-data').set('Authorization', 'Bearer notallowed');
    expect(res.status).toBe(403);
  });

  test('returns role/curriculum/grade/assignment breakdowns for an allowed admin', async () => {
    const res = await request(app).get('/charts-data').set('Authorization', 'Bearer allowed');
    expect(res.status).toBe(200);
    expect(res.body.roleCounts).toEqual({ student: 2, teacher: 1, parent: 1 });
    // Legacy NCERT students are counted as CBSE.
    expect(res.body.curriculumMap).toEqual({ CBSE: 2 });
    expect(res.body.gradeMap).toEqual({ 'Grade 5': 2 });
    expect(res.body.onboarding.student).toEqual({ done: 1, total: 2 });
    expect(res.body.assignmentStats).toMatchObject({ total: 2, completed: 1, pending: 1 });
    expect(res.body.assignmentStats.byType).toEqual({ quiz: 1, worksheet: 1 });
    expect(res.body.assignmentsLast7).toHaveLength(7);
    expect(res.body.topXP[0]).toMatchObject({ id: 's1', xp: 100 });
  });
});
