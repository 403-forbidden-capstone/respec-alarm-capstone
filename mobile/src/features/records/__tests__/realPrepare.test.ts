import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { formatTime } from '@/lib/format';

import { onCall, resetFake } from '../testing/fakeSupabase';
import { applySuggestion, getSuggestion, ignoreSuggestion, undoSuggestion } from '../real';

// 준비 알람 당김 제안(PREPARE_ADVANCE, 안건 D111) — 실데이터: 화면 타입으로 바꾸기 · 서버 suggestion-apply 부르기 · 폰 예약 맞추기
jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('../testing/fakeSupabase')>('../testing/fakeSupabase').fakeClient }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-19T11:00:00Z') }));
const mockApplyCommit = jest.fn<(r: unknown) => Promise<unknown>>();
jest.mock('@/lib/alarmSync', () => ({ reconcile: async () => ({}), applyCommit: (r: unknown) => mockApplyCommit(r) }));
const mockCallEdge = jest.fn<(name: string, body: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/lib/edge', () => ({ callEdge: (name: string, body: Record<string, unknown>) => mockCallEdge(name, body) }));

const ID = '2b9f6a4e-5c0e-4d3b-9a77-0a1b2c3d4e5f';
// 10월 20일(화) 9시 수업 — 기상 7:20 · 준비 7:30 · 출발 8:00 (한국 시각 → UTC는 9시간 앞)
const at = (hm: string) => new Date(`2026-10-20T${hm}:00+09:00`).toISOString();
const row = (patch: Record<string, unknown> = {}) => ({
  suggestion_id: ID,
  suggestion_type: 'PREPARE_ADVANCE',
  current_value: '0',
  suggested_value: '10',
  result_value: null,
  status: 'PENDING',
  target_alarm_id: 'prep',
  evidence: [10, 14, 12],
  alarms: {
    alarm_id: 'prep', participant_id: 'pt', alarm_type: 'PREPARE', scheduled_at: at('07:30'), intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: null,
    appointment_participants: { appointments: { appointment_id: 'appt', title: '수업', appointment_at: at('09:00') } },
    routines: null,
  },
  ...patch,
});
const alarms = (wake = '07:20', prep = '07:30') => [
  { alarm_type: 'WAKE', scheduled_at: at(wake) },
  { alarm_type: 'PREPARE', scheduled_at: at(prep) },
  { alarm_type: 'DEPARTURE', scheduled_at: at('08:00') },
];
const serve = (r: ReturnType<typeof row>, list = alarms()) =>
  onCall((c) => (c.table === 'alarm_suggestions' ? { data: r } : c.table === 'alarms' ? { data: list } : undefined));

beforeEach(() => {
  resetFake();
  mockCallEdge.mockReset();
  mockCallEdge.mockResolvedValue({ ring_packages: [{ alarmId: 'prep', type: 'PREPARE', atMillis: 1 }] });
  mockApplyCommit.mockReset();
  mockApplyCommit.mockResolvedValue({});
});

describe('준비 알람 당김 — 화면 타입', () => {
  it('기다림: 준비 7:30 → 7:20, 기상 그대로, 근거는 최근 것부터 (1회 전 +12 · 2회 전 +14 · 3회 전 +10), 평균 12분', async () => {
    serve(row());
    const s = await getSuggestion(ID);
    expect(s?.title).toBe('준비 알람을 10분 앞당겨 볼까요?');
    expect(s && [formatTime(s.currentPrepare!), formatTime(s.proposedPrepare!), formatTime(s.currentWake), formatTime(s.proposedWake), formatTime(s.depart)]).toEqual([
      '오전 7:30', '오전 7:20', '오전 7:20', '오전 7:20', '오전 8:00',
    ]);
    expect(s?.deltas).toEqual([{ label: '1회 전', value: '+12분' }, { label: '2회 전', value: '+14분' }, { label: '3회 전', value: '+10분' }]);
    expect(s?.reason).toBe('최근 3번의 준비가\n예상보다 평균 12분 더 걸렸어요.');
    expect(s?.bounds).toEqual({ earlier: 30, later: 0 });
    expect(s?.change).toBeUndefined();
  });

  it('적용한 뒤: DB 알람은 이미 옮겨져 있어(준비 7:20) 적용 전 시각을 거꾸로 — 적용 전 준비 7:30', async () => {
    serve(row({ status: 'APPLIED', result_value: '10' }), alarms('07:20', '07:20'));
    const s = await getSuggestion(ID);
    expect(s?.applied && [s.applied.minutes, formatTime(s.applied.prepare!), formatTime(s.currentPrepare!), formatTime(s.currentWake)]).toEqual([10, '오전 7:20', '오전 7:30', '오전 7:20']);
  });
});

describe('준비 알람 당김 — 서버 suggestion-apply', () => {
  it('제안대로 적용하면 APPLY, 고른 분이 다르면 EDIT — 돌려준 꾸러미로 폰 예약을 맞춤', async () => {
    serve(row());
    await applySuggestion(ID, 10);
    expect(mockCallEdge).toHaveBeenLastCalledWith('suggestion-apply', { suggestion_id: ID, action: 'APPLY' });
    expect(mockApplyCommit).toHaveBeenCalledWith({ ring_packages: [{ alarmId: 'prep', type: 'PREPARE', atMillis: 1 }], canceled_alarm_ids: [] });
    await applySuggestion(ID, 5);
    expect(mockCallEdge).toHaveBeenLastCalledWith('suggestion-apply', { suggestion_id: ID, action: 'EDIT', minutes: 5 });
  });

  it('이미 적용한 제안을 다시 고치면 되돌린 뒤 새 값으로 (REVERT → EDIT)', async () => {
    serve(row({ status: 'APPLIED', result_value: '10' }));
    await applySuggestion(ID, 7);
    expect(mockCallEdge.mock.calls.map((c) => c[1].action)).toEqual(['REVERT', 'EDIT']);
  });

  it('되돌리기는 REVERT, 무시는 IGNORE — 늦추는 쪽(음수)은 서버를 부르지 않고 거절', async () => {
    serve(row({ status: 'APPLIED', result_value: '10' }));
    await undoSuggestion(ID);
    expect(mockCallEdge).toHaveBeenLastCalledWith('suggestion-apply', { suggestion_id: ID, action: 'REVERT' });
    resetFake();
    serve(row());
    await ignoreSuggestion(ID);
    expect(mockCallEdge).toHaveBeenLastCalledWith('suggestion-apply', { suggestion_id: ID, action: 'IGNORE' });
    mockCallEdge.mockClear();
    await expect(applySuggestion(ID, -5)).rejects.toThrow('당길 시간을 골라 주세요');
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('폰 예약 맞추기가 실패해도 적용은 성공으로 (서버 저장은 끝남)', async () => {
    serve(row());
    mockApplyCommit.mockRejectedValue(new Error('phone'));
    await expect(applySuggestion(ID, 10)).resolves.toBeUndefined();
  });
});
