const request = require('supertest');

process.env.ADMIN_EMAILS = 'allowed@aivorah.test';

jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async () => ({ email: 'allowed@aivorah.test' })) }),
}));
jest.mock('../services/supabase', () => ({ from: jest.fn() }));
jest.mock('../services/bulkImport', () => ({ importStudents: jest.fn(async () => ({ created: 1, errors: [] })) }));
const { importStudents } = require('../services/bulkImport');

const app = require('../index');
const post = (body) => request(app).post('/students/bulk-import').set('Authorization', 'Bearer allowed').send(body);

describe('POST /students/bulk-import', () => {
  test('rejects without a token', async () => {
    expect((await request(app).post('/students/bulk-import').send({})).status).toBe(401);
  });

  test('requires a school and at least one row, and caps the batch size', async () => {
    expect((await post({ rows: [{ studentName: 'A' }] })).status).toBe(400);
    expect((await post({ schoolId: 's', rows: [] })).status).toBe(400);
    expect((await post({ schoolId: 's', rows: Array(501).fill({ studentName: 'A' }) })).status).toBe(400);
    expect(importStudents).not.toHaveBeenCalled();
  });

  test('passes the batch and the signed-in admin through to the importer', async () => {
    const res = await post({ schoolId: 's1', fileName: 'x.xlsx', rows: [{ studentName: 'A' }] });
    expect(res.status).toBe(200);
    expect(importStudents).toHaveBeenCalledWith({ schoolId: 's1', fileName: 'x.xlsx', rows: [{ studentName: 'A' }], runByEmail: 'allowed@aivorah.test' });
  });
});
