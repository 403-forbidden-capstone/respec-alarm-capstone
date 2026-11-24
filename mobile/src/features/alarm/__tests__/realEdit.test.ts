import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

import { rememberDetail, recallDetail } from '../detailCache';
import * as real from '../realEdit';
import type { AppointmentDetail } from '../types';

// 실서버 일정 수정 · 삭제(realEdit.ts) — appointment-edit 요청 변환 · 응답 처리 · 오류 문구 · 폰 반영 순서.
//   서버 계산(범위 · 확인 · 7.1.3)은 supabase/functions/_shared/edit*.test.ts가 맡음

const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>, options?: unknown) => Promise<unknown>>();
jest.mock('@/lib/edge', () => ({ ...jest.requireActual<object>('@/lib/edge'), callEdge: (name: string, body?: Record<string, unknown>, options?: unknown) => mockCallEdge(name, body, options) }));

const mockApplyCommit = jest.fn<(result: unknown) => Promise<{ failed: unknown[] }>>();
const mockSyncNow = jest.fn<(options?: unknown) => Promise<void>>();
jest.mock('@/lib/alarmSync', () => ({
  applyCommit: (r: unknown) => mockApplyCommit(r),
  syncNow: (o?: unknown) => mockSyncNow(o),
}));

const ID = '00000000-0000-4000-8000-0000000000a1';
const common = { appointment_id: ID, ring_packages: [] as unknown[], canceled_alarm_ids: [] as string[], warnings: [] as unknown[] };
const edgeError = (code: ConstructorParameters<typeof EdgeError>[0], details?: unknown) => new EdgeError(code, { details });

// 마이크로태스크 비우기 — void로 띄운 syncNow가 불렸는지 보려고
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockCallEdge.mockReset();
  mockApplyCommit.mockResolvedValue({ failed: [] });
  mockSyncNow.mockResolvedValue();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('요청 변환 (toEditPatch · updateAppointment)', () => {
  const updateOk = { ...common, saved: true, needs_confirm: false, changes: [], alarms: [], deleted_appointment_ids: [] };
  const sentBody = () => mockCallEdge.mock.calls[0][1];

  it('제목만: patch는 title 하나, scope는 그대로, 확인 칸(confirmed)은 안 보냄', async () => {
    mockCallEdge.mockResolvedValueOnce(updateOk);
    await real.updateAppointment(ID, { title: '  팀 회의 ' }, 'this');
    expect(mockCallEdge.mock.calls[0][0]).toBe('appointment-edit');
    expect(sentBody()).toEqual({ action: 'UPDATE', appointment_id: ID, scope: 'this', patch: { title: '팀 회의' } });
  });

  it('시각: appointment_at은 alarm-commit과 같은 ISO(오프셋 있는 UTC) 글자', async () => {
    mockCallEdge.mockResolvedValueOnce(updateOk);
    await real.updateAppointment(ID, { at: new Date('2025-05-22T10:30:00+09:00') }, 'this');
    expect((sentBody() as { patch: unknown }).patch).toEqual({ appointment_at: '2025-05-22T01:30:00.000Z' });
  });

  it('장소: 좌표가 둘 다 있으면 destination에 같이, 하나라도 없으면 이름만 · 중요도도 그대로', async () => {
    mockCallEdge.mockResolvedValue(updateOk);
    await real.updateAppointment(ID, { place: '세종대학교', placeLat: 37.55, placeLng: 127.07, importance: 'HIGH' }, 'this');
    expect((mockCallEdge.mock.calls[0][1] as { patch: unknown }).patch).toEqual({ destination: { name: '세종대학교', lat: 37.55, lng: 127.07 }, importance: 'HIGH' });
    await real.updateAppointment(ID, { place: '도서관', placeLat: 37.5 }, 'this');
    expect((mockCallEdge.mock.calls[1][1] as { patch: unknown }).patch).toEqual({ destination: { name: '도서관' } });
  });

  it('반복 끔: repeatDays 빈 목록 → recurrence_rule null, 요일이 있으면 RRULE, 안 넣으면 칸 없음 · scope following', async () => {
    mockCallEdge.mockResolvedValue(updateOk);
    await real.updateAppointment(ID, { repeatDays: [] }, 'following');
    expect(mockCallEdge.mock.calls[0][1]).toEqual({ action: 'UPDATE', appointment_id: ID, scope: 'following', patch: { recurrence_rule: null } });
    await real.updateAppointment(ID, { repeatDays: ['월', '수'] }, 'following');
    expect((mockCallEdge.mock.calls[1][1] as { patch: unknown }).patch).toEqual({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    await real.updateAppointment(ID, { title: 'x' }, 'following');
    expect((mockCallEdge.mock.calls[2][1] as { patch: Record<string, unknown> }).patch).not.toHaveProperty('recurrence_rule');
  });

  it('confirmed 옵션은 그대로 서버에 전달 (true일 때만 칸이 있음)', async () => {
    mockCallEdge.mockResolvedValue(updateOk);
    await real.updateAppointment(ID, { title: 'a' }, 'this', { confirmed: true });
    expect(mockCallEdge.mock.calls[0][1]).toMatchObject({ confirmed: true });
    await real.updateAppointment(ID, { title: 'a' }, 'this', { confirmed: false });
    expect(mockCallEdge.mock.calls[1][1]).not.toHaveProperty('confirmed');
  });

  it('빈 제목 · 빈 장소는 서버에 보내기 전에 이유를 알림', async () => {
    await expect(real.updateAppointment(ID, { title: '  ' }, 'this')).rejects.toThrow('일정 이름을 입력해 주세요');
    await expect(real.updateAppointment(ID, { place: '' }, 'this')).rejects.toThrow('장소를 골라 주세요');
    expect(mockCallEdge).not.toHaveBeenCalled();
  });
});

describe('응답 처리 (updateAppointment)', () => {
  it('needs_confirm: 저장 안 한 상태로 changes(ISO → Date)와 needsConfirm true만 돌려줌 — 폰 예약 · 맞추기는 건드리지 않음', async () => {
    mockCallEdge.mockResolvedValueOnce({
      ...common,
      saved: false,
      needs_confirm: true,
      changes: [{ kind: 'WAKE', from: '2025-05-22T07:00:00+09:00', to: '2025-05-22T08:00:00+09:00' }],
      alarms: [],
      deleted_appointment_ids: [],
    });
    const res = await real.updateAppointment(ID, { at: new Date('2025-05-22T11:00:00+09:00') }, 'this');
    expect(res.needsConfirm).toBe(true);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].kind).toBe('WAKE');
    expect(res.changes[0].from).toBeInstanceOf(Date);
    expect(res.changes[0].from.getTime()).toBe(new Date('2025-05-22T07:00:00+09:00').getTime());
    expect(res.changes[0].to.getTime()).toBe(new Date('2025-05-22T08:00:00+09:00').getTime());
    await flush();
    expect(mockApplyCommit).not.toHaveBeenCalled();
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('저장됨: ring_packages · canceled_alarm_ids를 applyCommit에 그대로 넘기고 그 다음 syncNow를 한 번', async () => {
    const pkg = { alarmId: 'a-1', atMillis: 1 };
    mockCallEdge.mockResolvedValueOnce({
      ...common,
      ring_packages: [pkg],
      canceled_alarm_ids: ['a-old'],
      saved: true,
      needs_confirm: false,
      changes: [{ kind: 'DEPARTURE', from: '2025-05-22T09:00:00+09:00', to: '2025-05-22T08:30:00+09:00' }],
      alarms: [],
      deleted_appointment_ids: [],
    });
    const order: string[] = [];
    mockApplyCommit.mockImplementationOnce(async () => (order.push('apply'), { failed: [] }));
    mockSyncNow.mockImplementationOnce(async () => void order.push('sync'));

    const res = await real.updateAppointment(ID, { at: new Date('2025-05-22T10:00:00+09:00') }, 'this');
    expect(res.needsConfirm).toBe(false);
    expect(res.changes.map((c) => c.kind)).toEqual(['DEPARTURE']);
    expect(mockApplyCommit).toHaveBeenCalledWith({ ring_packages: [pkg], canceled_alarm_ids: ['a-old'] });
    await flush();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['apply', 'sync']);
  });

  it('변경 없음(ring_packages 빈 응답)도 저장된 것으로 보고 맞추기를 한 번 — 응답이 유실된 재시도에서 폰에 옛 예약이 남지 않게', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, saved: true, needs_confirm: false, changes: [], alarms: [], deleted_appointment_ids: [] });
    const res = await real.updateAppointment(ID, { title: '같은 제목' }, 'this');
    expect(res).toEqual({ changes: [], needsConfirm: false });
    await flush();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('폰 반영 · 맞추기가 실패해도 던지지 않음 (서버에는 이미 저장됨), H03 기억해 둔 값은 비움', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, saved: true, needs_confirm: false, changes: [], alarms: [], deleted_appointment_ids: ['gone-1'] });
    mockApplyCommit.mockRejectedValueOnce(new Error('권한 없음'));
    mockSyncNow.mockRejectedValueOnce(new Error('네트워크'));
    rememberDetail({ id: ID } as AppointmentDetail);
    rememberDetail({ id: 'gone-1' } as AppointmentDetail);
    await expect(real.updateAppointment(ID, { title: 'x' }, 'this')).resolves.toEqual({ changes: [], needsConfirm: false });
    await flush();
    expect(recallDetail(ID)).toBeUndefined();
    expect(recallDetail('gone-1')).toBeUndefined();
  });
});

describe('지우기 · 되돌리기 · 빠지기', () => {
  it('deleteAppointment: DELETE 요청(scope 그대로) → canceled_alarm_ids를 applyCommit에 넘겨 폰 예약을 지우고 맞추기', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, canceled_alarm_ids: ['a-1', 'a-2'], deleted: true, mode: 'FROM_HERE', deleted_appointment_ids: [ID] });
    await real.deleteAppointment(ID, 'following');
    expect(mockCallEdge.mock.calls[0][1]).toEqual({ action: 'DELETE', appointment_id: ID, scope: 'following' });
    expect(mockApplyCommit).toHaveBeenCalledWith({ ring_packages: [], canceled_alarm_ids: ['a-1', 'a-2'] });
    await flush();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('deleteAppointment: 이미 지워진 일정(mode NONE)도 성공 — 그래도 맞추기', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, deleted: false, mode: 'NONE', deleted_appointment_ids: [] });
    await expect(real.deleteAppointment(ID, 'this')).resolves.toBeUndefined();
    await flush();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('restoreAppointment: 되살림 → 새 꾸러미를 폰에 걸고 맞추기', async () => {
    const pkg = { alarmId: 'a-9', atMillis: 9 };
    mockCallEdge.mockResolvedValueOnce({ ...common, ring_packages: [pkg], restored: true });
    await real.restoreAppointment(ID);
    expect(mockCallEdge.mock.calls[0][1]).toEqual({ action: 'RESTORE', appointment_id: ID });
    expect(mockApplyCommit).toHaveBeenCalledWith({ ring_packages: [pkg], canceled_alarm_ids: [] });
    await flush();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('restoreAppointment: 서버가 restored false(한 번짜리 · 이후 모두 지우기는 행이 없음)면 사용자가 알 수 있는 UserError, 폰은 안 건드림', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, restored: false, reason: 'NOT_FOUND' });
    const error = await real.restoreAppointment(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toBe('이 일정은 되돌릴 수 없어요. 새로 만들어 주세요');
    expect(mockApplyCommit).not.toHaveBeenCalled();
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('restoreAppointment: NOT_DELETED(이미 되살림 · 같은 요청 두 번째)는 성공', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, restored: false, reason: 'NOT_DELETED' });
    await expect(real.restoreAppointment(ID)).resolves.toBeUndefined();
  });

  it('leaveSharedAppointment: LEAVE 요청 → 내 알람 예약 지움 · 맞추기. left false(이미 빠짐)도 성공', async () => {
    mockCallEdge.mockResolvedValueOnce({ ...common, canceled_alarm_ids: ['mine-1'], left: true });
    await real.leaveSharedAppointment(ID);
    expect(mockCallEdge.mock.calls[0][1]).toEqual({ action: 'LEAVE', appointment_id: ID });
    expect(mockApplyCommit).toHaveBeenCalledWith({ ring_packages: [], canceled_alarm_ids: ['mine-1'] });
    mockCallEdge.mockResolvedValueOnce({ ...common, left: false });
    await expect(real.leaveSharedAppointment(ID)).resolves.toBeUndefined();
  });
});

describe('오류 문구 (editError)', () => {
  const messageOf = async (error: unknown) => {
    mockCallEdge.mockRejectedValueOnce(error);
    const thrown = await real.deleteAppointment(ID, 'this').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(UserError); // 화면은 UserError만 문구 그대로 보여 줌
    return (thrown as Error).message;
  };

  it('코드별: NOT_FOUND · FORBIDDEN · ROUTE_UNAVAILABLE', async () => {
    expect(await messageOf(edgeError('NOT_FOUND'))).toBe('일정을 찾을 수 없어요. 이미 지워졌을 수 있어요');
    expect(await messageOf(edgeError('FORBIDDEN'))).toBe('이 공동 약속은 지금 고치거나 지울 수 없어요. 그룹에 참여 중인지 확인해 주세요');
    expect(await messageOf(edgeError('ROUTE_UNAVAILABLE'))).toBe('새 장소까지 이동시간을 구하지 못했어요. 장소를 검색해서 골라 주세요');
  });

  it('UNPROCESSABLE의 이유별: 공동 약속 제한 · 기록 있음 · 공동 약속 아님', async () => {
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'GROUP_RECURRENCE_LATER' }))).toBe('공동 약속의 반복은 아직 고칠 수 없어요');
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'PAST_APPOINTMENT' }))).toBe('지난 약속이에요');
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'HAS_RECORDS' }))).toBe('출발 · 도착 기록이 있는 일정은 지우거나 빠질 수 없어요');
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'NOT_SHARED' }))).toBe('공동 약속이 아니에요');
  });

  it('UNPROCESSABLE 중 출발 시각 지남 · 순서 어긋남은 lib/edge의 문구, 모르는 이유는 일반 문구', async () => {
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'DEPARTURE_PASSED' }))).toBe('출발 시각이 이미 지나서 저장할 수 없어요');
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'ORDER' }))).toBe('알람 순서가 맞지 않아요. 기상 → 준비 → 출발 순서로 맞춰 주세요');
    expect(await messageOf(edgeError('UNPROCESSABLE', { reason: 'SOMETHING_NEW' }))).toBe('이 내용으로는 저장할 수 없어요');
  });

  it('그 밖(네트워크 · 서버 오류)은 일반 문구 그대로, 폰은 안 건드림', async () => {
    expect(await messageOf(edgeError('NETWORK'))).toBe('인터넷 연결을 확인해 주세요');
    expect(await messageOf(edgeError('INTERNAL'))).toBe('서버에 문제가 생겼어요. 잠시 뒤에 다시 해 주세요');
    expect(mockApplyCommit).not.toHaveBeenCalled();
    expect(mockSyncNow).not.toHaveBeenCalled();
  });
});
