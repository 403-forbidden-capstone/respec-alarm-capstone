import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError, messageFor } from '@/lib/edge';

import { groupChangeAction, settingsDraftOf } from '../groupChange';
import { editError } from '../realEdit';
import * as real from '../real';
import { selectableTransport } from '../realPlan';
import { joinBody, newAppointmentBody } from '../request';
import { TravelConfirmNeeded } from '../travelConfirm';
import type { AppointmentDraft } from '../types';

// 친구 9장 앱 층 — 공동 약속의 알람 쪽 (시험케이스 9-03 · 9-21 · 9-27 · 9-32 · 9-35 · 9-36, 세션약속 2절 11/9 9장 줄)
//   H05 '함께할 그룹' · [내 알람 만들기](alarm-commit appointment_id) · 거절 사유 문구 · 공동 약속 변경 푸시 처리
const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>, options?: unknown) => Promise<unknown>>();
jest.mock('@/lib/edge', () => {
  const actual = jest.requireActual<typeof import('@/lib/edge')>('@/lib/edge');
  return { ...actual, callEdge: (name: string, body?: Record<string, unknown>, options?: unknown) => mockCallEdge(name, body, options) };
});
const mockApplyCommit = jest.fn<(result: unknown) => Promise<{ failed: { alarmId: string }[] }>>();
jest.mock('@/lib/alarmSync', () => ({
  applyCommit: (r: unknown) => mockApplyCommit(r),
  reconcile: jest.fn(async () => ({ failed: [] })),
  syncNow: jest.fn(async () => undefined),
  uploadEvents: jest.fn(async () => undefined),
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'me' }));
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const ME = 'me';
const draft = (over: Partial<AppointmentDraft> = {}): AppointmentDraft => ({
  title: '스터디',
  date: new Date('2026-10-20T00:00:00+09:00'),
  time: '10:00',
  repeat: [],
  place: '세종대학교',
  transport: 'TRANSIT',
  importance: 'LOW',
  items: '',
  alarms: { WAKE: true, PREPARE: true, DEPARTURE: true },
  ...over,
});

beforeEach(() => {
  mockCallEdge.mockReset();
  mockApplyCommit.mockReset();
  mockApplyCommit.mockResolvedValue({ failed: [] });
});

describe('H05 함께할 그룹 (9-가)', () => {
  it('그룹을 고르면 새 약속 요청에 group_id 한 줄, 안 고르면 없음', () => {
    const at = new Date('2026-10-20T01:00:00.000Z');
    expect((newAppointmentBody(draft({ groupId: 'g1' }), at).appointment as Record<string, unknown>).group_id).toBe('g1');
    expect(newAppointmentBody(draft(), at).appointment).not.toHaveProperty('group_id');
    expect(newAppointmentBody(draft({ groupId: null }), at).appointment).not.toHaveProperty('group_id');
  });
});

describe('[내 알람 만들기] (9-03 · 9-35)', () => {
  it('요청 = 기존 약속 id + 내 집 · 고른 수단(+ 고친 준비 시간) + 기상 · 준비 · 출발', () => {
    expect(joinBody('ap1', { transport: 'WALK', prepareMinutes: null })).toEqual({
      appointment_id: 'ap1',
      participant: { origin: { name: '집' }, transport_type: 'WALK' },
      kinds: ['WAKE', 'PREPARE', 'DEPARTURE'],
    });
    expect((joinBody('ap1', { transport: 'TRANSIT', prepareMinutes: 50 }).participant as Record<string, unknown>).prepare_minutes).toBe(50);
  });

  it('토스트에 쓸 기상 · 출발 알람 시각을 같이 돌려줌 (D-16)', async () => {
    const alarm = (alarm_type: string, scheduled_at: string, is_enabled = true) => ({ alarm_id: alarm_type, alarm_type, scheduled_at, is_enabled });
    mockCallEdge.mockResolvedValue({
      appointment_id: 'ap1',
      alarms: [alarm('WAKE', '2026-10-20T07:20:00+09:00'), alarm('PREPARE', '2026-10-20T07:40:00+09:00'), alarm('DEPARTURE', '2026-10-20T08:30:00+09:00')],
      ring_packages: [],
      canceled_alarm_ids: [],
    });
    const r = await real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null });
    expect((r as { wakeAt?: Date }).wakeAt?.getTime()).toBe(new Date('2026-10-20T07:20:00+09:00').getTime());
    expect((r as { departAt?: Date }).departAt?.getTime()).toBe(new Date('2026-10-20T08:30:00+09:00').getTime());
  });

  it('프로필 기본 이동 수단을 시트 선택지(대중교통 · 자차 · 도보)로 맞춤 (D-15)', () => {
    expect(selectableTransport('SUBWAY')).toBe('TRANSIT');
    expect(selectableTransport('BUS')).toBe('TRANSIT');
    expect(selectableTransport('TRANSIT')).toBe('TRANSIT');
    expect(selectableTransport('CAR')).toBe('CAR');
    expect(selectableTransport('WALK')).toBe('WALK');
    expect(selectableTransport(null)).toBe('TRANSIT');
  });

  it('저장하면 폰에 걺(applyCommit) — 폰에 못 건 알람 수만 돌려줌', async () => {
    const res = { appointment_id: 'ap1', alarms: [], ring_packages: [{ alarmId: 'w1' }], canceled_alarm_ids: [] };
    mockCallEdge.mockResolvedValue(res);
    mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'w1' }] });
    await expect(real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null })).resolves.toEqual({ phoneFailed: 1 });
    expect(mockCallEdge.mock.calls[0][0]).toBe('alarm-commit');
    expect(mockApplyCommit).toHaveBeenCalledTimes(1);
  });

  it('오프라인이면 그대로 던지고(다시 하기), 폰에는 아무것도 안 걺 — 같은 요청을 다시 보내도 서버는 내 참여 한 줄', async () => {
    mockCallEdge.mockRejectedValueOnce(new EdgeError('NETWORK'));
    await expect(real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null })).rejects.toBeInstanceOf(EdgeError);
    expect(mockApplyCommit).not.toHaveBeenCalled();
  });
});

describe('[내 알람 만들기] 길찾기 실패 (9-어)', () => {
  it('어림 이동시간이 오면 TravelConfirmNeeded — 확인한 분은 MANUAL로 다시 보냄', async () => {
    mockCallEdge.mockRejectedValueOnce(new EdgeError('ROUTE_UNAVAILABLE', { details: { fallback: { minutes: 30, source: 'ESTIMATE' } } }));
    const error = await real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TravelConfirmNeeded);
    expect((error as TravelConfirmNeeded).minutes).toBe(30);
    mockCallEdge.mockResolvedValueOnce({ appointment_id: 'ap1', alarms: [], ring_packages: [], canceled_alarm_ids: [] });
    await real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null, travelMinutes: 30 });
    const body = mockCallEdge.mock.calls[1][1] as { participant: Record<string, unknown> };
    expect(body.participant).toMatchObject({ est_travel_minutes: 30, travel_source: 'MANUAL' });
  });

  it('어림값도 없으면(좌표 없음) 직접 입력 안내 대신 다시 해 달라는 문구', async () => {
    mockCallEdge.mockRejectedValueOnce(new EdgeError('ROUTE_UNAVAILABLE', { details: { manual_required: true } }));
    await expect(real.joinSharedAppointment('ap1', { transport: 'TRANSIT', prepareMinutes: null })).rejects.toThrow('이동시간을 구하지 못해 알람을 만들지 못했어요. 잠시 뒤 다시 해 주세요');
  });
});

describe('지난 약속 · 거절 사유 (9-32 · 9-36)', () => {
  it('PAST_APPOINTMENT는 "지난 약속이에요" (참여 · 고치기 둘 다)', () => {
    expect(messageFor('UNPROCESSABLE', { reason: 'PAST_APPOINTMENT' })).toBe('지난 약속이에요');
    expect((editError(new EdgeError('UNPROCESSABLE', { details: { reason: 'PAST_APPOINTMENT' } })) as Error).message).toBe('지난 약속이에요');
  });

  it('공동 약속 반복 고치기는 아직 안 됨, 옛 GROUP_EDIT_LIMIT 문구는 없음', () => {
    expect((editError(new EdgeError('UNPROCESSABLE', { details: { reason: 'GROUP_RECURRENCE_LATER' } })) as Error).message).toBe('공동 약속의 반복은 아직 고칠 수 없어요');
    expect((editError(new EdgeError('UNPROCESSABLE', { details: { reason: 'GROUP_EDIT_LIMIT' } })) as Error).message).not.toContain('지우고 다시 만들어');
  });

  it('오프라인에서 고치기는 통신 오류 그대로(값은 화면에 남음)', () => {
    const e = new EdgeError('NETWORK');
    expect(editError(e)).toBe(e);
  });
});

describe('공동 약속 변경 푸시 (세션약속 1절 공동 약속 푸시 데이터)', () => {
  const base = { kind: 'GROUP_APPT_CHANGED', groupId: 'g1', appointmentId: 'ap1', recipientUserId: ME };

  it('취소면 그 약속 알람을 지우고, 바뀜이면 서버가 맞췄으면 맞추기 · 못 맞췄으면 확인 화면', () => {
    expect(groupChangeAction({ ...base, change: 'CANCELED' })).toEqual({ type: 'CANCELED', appointmentId: 'ap1' });
    expect(groupChangeAction({ ...base, change: 'CHANGED', needsConfirm: false })).toEqual({ type: 'SYNC', appointmentId: 'ap1' });
    expect(groupChangeAction({ ...base, change: 'CHANGED', needsConfirm: true })).toEqual({ type: 'CONFIRM', appointmentId: 'ap1' });
  });

  it('다른 종류 · 모양이 다른 데이터는 null (needsConfirm 문자열 "true"도 확인으로 봄)', () => {
    expect(groupChangeAction({ ...base, kind: 'WAKE_PING', change: 'CHANGED' })).toBeNull();
    expect(groupChangeAction({ ...base, change: 'CHANGED', appointmentId: undefined })).toBeNull();
    expect(groupChangeAction(null)).toBeNull();
    expect(groupChangeAction({ ...base, change: 'CHANGED', needsConfirm: 'true' })).toEqual({ type: 'CONFIRM', appointmentId: 'ap1' });
  });
});

describe('확인 화면 [새 시각으로 맞추기] 저장 값', () => {
  it('지금 내 조건 그대로 — 종류별 켜기(도착 제외) · 직접 고른 강도만', () => {
    const saved = {
      edits: { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} },
      alarms: [
        { id: 'w', kind: 'WAKE', at: new Date(), enabled: true },
        { id: 'p', kind: 'PREPARE', at: new Date(), enabled: false },
        { id: 'a', kind: 'ARRIVE', at: new Date(), enabled: true },
      ],
      intensity: { axes: { sound: { level: 2, manual: true }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } } },
    } as unknown as Parameters<typeof settingsDraftOf>[0];
    expect(settingsDraftOf(saved)).toEqual({
      bufferMinutes: 10,
      origin: '집',
      transport: 'TRANSIT',
      travelMinutes: null,
      prepareMinutes: null,
      times: {},
      kinds: { WAKE: true, PREPARE: false },
      levels: { sound: 2, voice: null, vibration: null },
    });
  });
});
