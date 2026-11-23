import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { canConfirmPrepStartAt, confirmPrepStartSelfReport, loadPrepStartSelfReport } from '../selfReportedPrep';

let mockHandler: (call: FakeCall) => FakeResult | undefined = () => undefined;
let mockRpcHandler: () => { data: unknown; error: { code?: string; message: string } | null } =
  () => ({ data: '2026-11-25T00:00:00.000Z', error: null });
const mockCalls: FakeCall[] = [];
const mockRpcCalls: { name: string; args: unknown }[] = [];
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
  return { supabase: {
    from: (table: string) => fakeBuilder(table, (call) => { mockCalls.push(call); return mockHandler(call); }),
    rpc: (name: string, args: unknown) => { mockRpcCalls.push({ name, args }); return mockRpcHandler(); },
  } };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
const appointment = '01234567-89ab-4abc-8def-0123456789ab';
describe('self-reported prep start pilot', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockRpcCalls.length = 0;
    mockHandler = () => ({ data: { self_reported_prep_started_at: null, departed_at: null } });
    mockRpcHandler = () => ({ data: '2026-11-25T00:00:00.000Z', error: null });
  });
  it('accepts only real-time tap around own appointment', () => {
    const at = new Date('2026-11-25T10:00:00.000Z');
    expect(canConfirmPrepStartAt(at, new Date('2026-11-25T07:00:00.000Z'))).toBe(true);
    expect(canConfirmPrepStartAt(at, new Date('2026-11-25T11:00:00.000Z'))).toBe(true);
    expect(canConfirmPrepStartAt(at, new Date('2026-11-25T06:59:59.000Z'))).toBe(false);
    expect(canConfirmPrepStartAt(at, new Date('2026-11-25T11:00:01.000Z'))).toBe(false);
    expect(canConfirmPrepStartAt(at, new Date(Number.NaN))).toBe(false);
  });
  it('read is scoped to current user and does not write to alarm data', async () => {
    const status = await loadPrepStartSelfReport(appointment);
    expect(status?.self_reported_prep_started_at).toBeNull();
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0]).toMatchObject({ table: 'appointment_participants', op: 'select', columns: 'self_reported_prep_started_at, departed_at' });
    expect(filterArgs(mockCalls[0], 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(mockCalls[0], 'eq', 'appointment_id')).toEqual([appointment]);
  });
  it('RPC generates time on the server; client cannot forge a timestamp', async () => {
    const recorded = await confirmPrepStartSelfReport(appointment);
    expect(recorded).toBe('2026-11-25T00:00:00.000Z');
    expect(mockRpcCalls).toEqual([{ name: 'confirm_prep_start_self_report', args: { p_appointment_id: appointment } }]);
    expect(mockCalls).toEqual([]);
  });
  it('failed and unparseable RPC responses are rejected', async () => {
    mockRpcHandler = () => ({ data: null, error: { code: '22023', message: 'prep_start_not_eligible' } });
    await expect(confirmPrepStartSelfReport(appointment)).rejects.toMatchObject({ code: '22023' });
    mockRpcHandler = () => ({ data: null, error: null });
    await expect(confirmPrepStartSelfReport(appointment)).rejects.toThrow(/Missing confirmed/);
  });
});
