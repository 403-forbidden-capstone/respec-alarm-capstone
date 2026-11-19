import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { calls, onCall, resetFake } from '@/features/records/testing/fakeSupabase';

jest.mock('@/lib/supabase', () => ({
  supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>(
    '@/features/records/testing/fakeSupabase').fakeClient,
}));

import { getMyProfile } from '@/features/profile/api';
import { inspectPurePrepDb } from '../purePrepDiagnostics';

beforeEach(resetFake);

describe('read-only real-data schema diagnostics', () => {
  it('reports pre-migration state without writing or hiding the existing value', async () => {
    onCall((c) => c.columns?.includes('default_outing_prep_minutes')
      ? { error: { code: '42703', message: 'column profiles.default_outing_prep_minutes does not exist' } }
      : { data: [{ default_prepare_minutes: 65 }] });
    await expect(inspectPurePrepDb('u1')).resolves.toEqual({
      kind: 'migration-needed', missing: 'profiles', legacyMinutes: 65,
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.op === 'select')).toBe(true);
    expect(calls.every((c) => c.filters.some((f) => f.method === 'eq' && f.args[0] === 'user_id' && f.args[1] === 'u1'))).toBe(true);
  });

  it('reports participant migration missing while keeping profile read-only', async () => {
    onCall((c) => c.table === 'profiles'
      ? { data: [{ default_prepare_minutes: 60, default_outing_prep_minutes: 35 }] }
      : { error: { code: '42703', message: 'column appointment_participants.outing_prep_minutes does not exist' } });
    await expect(inspectPurePrepDb('u1')).resolves.toEqual({
      kind: 'migration-needed', missing: 'appointment_participants', legacyMinutes: 60,
    });
    expect(calls.every((c) => c.op === 'select')).toBe(true);
  });

  it('reports ready only when profile and participant columns are queryable', async () => {
    onCall((c) => c.table === 'profiles'
      ? { data: [{ default_prepare_minutes: 60, default_outing_prep_minutes: 35 }] }
      : { data: [] });
    await expect(inspectPurePrepDb('u1')).resolves.toEqual({
      kind: 'ready', legacyMinutes: 60, pureMinutes: 35, participantProvenance: 'ready',
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.op === 'select')).toBe(true);
  });

  it('does not treat authorization errors as migrations pending', async () => {
    onCall(() => ({ error: { code: '42501', message: 'permission denied' } }));
    const result = await inspectPurePrepDb('u1');
    expect(result.kind).toBe('error');
  });

  it('falls back to legacy profile read only for the missing new column', async () => {
    onCall((c) => c.columns?.includes('default_outing_prep_minutes')
      ? { error: { code: '42703', message: 'column profiles.default_outing_prep_minutes does not exist' } }
      : { data: [{ user_id: 'u1', nickname: 'test', default_prepare_minutes: 65 }] });
    const profile = await getMyProfile('u1');
    expect(profile?.default_outing_prep_minutes).toBeNull();
    expect(profile?.default_prepare_minutes).toBe(65);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.op === 'select')).toBe(true);
  });

  it('does not fall back on missing unrelated columns', async () => {
    onCall(() => ({ error: { code: '42703', message: 'column profiles.nickname does not exist' } }));
    await expect(getMyProfile('u1')).rejects.toMatchObject({ code: '42703' });
    expect(calls).toHaveLength(1);
  });
});
