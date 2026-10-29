import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import * as api from '../api';
import type { AlarmEdits, AlarmSettingsDraft, Estimate } from '../types';

// api.ts가 함수 맨 앞에서 실데이터(real.ts)와 가짜를 나누는 패턴의 시험 — 다른 기능(records · routine · social)도 같은 모양으로 확인함
//   실데이터 모드면 real.ts로 넘기고 가짜 데이터를 건드리지 않음, 가짜 모드면 real.ts를 부르지 않음
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

// real.ts가 내보내는 함수 전부를 한 곳으로 모아 어떤 이름으로 어떤 인자가 넘어갔는지 확인
const mockReal = jest.fn<(name: string, ...args: unknown[]) => Promise<unknown>>();
jest.mock('../real', () => {
  const names = [
    'getNextAlarm',
    'listAppointments',
    'getDaySchedule',
    'getAppointment',
    'previewAlarms',
    'recordEdit',
    'listEditLogs',
    'setAppointmentEnabled',
    'setAlarmEnabled',
    'setIntensity',
    'saveAlarmSettings',
    'listPlaces',
    'estimateAppointment',
    'createAppointment',
    'saveStandaloneAlarm',
    'getRing',
    'startRing',
    'stopRing',
    'snoozeRing',
    'getSnooze',
    'cancelSnooze',
    'dismissRing',
    'getWakeCheck',
    'getWakeInProgress',
    'recheckRecentWakes',
    'promptWake',
    'confirmWake',
    'getMorningPlan',
    'checkDepartNow',
  ];
  return Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => mockReal(name, ...args)]));
});

beforeEach(() => {
  mockIsMock = true;
  mockReal.mockReset();
});

describe('api.ts 가짜 · 실데이터 나누기 (getNextAlarm)', () => {
  it('실데이터 모드면 real.ts의 결과를 그대로 돌려줌', async () => {
    mockIsMock = false;
    mockReal.mockResolvedValue(null);
    await expect(api.getNextAlarm()).resolves.toBeNull();
    expect(mockReal).toHaveBeenCalledTimes(1);
  });

  it('실데이터 읽기 실패는 가짜로 바꾸지 않고 그대로 던짐 (화면이 LoadError로 보여 줌)', async () => {
    mockIsMock = false;
    mockReal.mockRejectedValue(new Error('network'));
    await expect(api.getNextAlarm()).rejects.toThrow('network');
  });

  it('가짜 모드면 real.ts를 부르지 않고 목업 일정에서 고름', async () => {
    const next = await api.getNextAlarm();
    expect(mockReal).not.toHaveBeenCalled();
    expect(next?.appointment.title).toBe('팀 주간회의');
  });
});

describe('실데이터 모드: 알람 api 전부가 real.ts로 넘어감', () => {
  const sentinel = { sentinel: true };
  const edits = { bufferMinutes: 10 } as unknown as AlarmEdits;
  const settings = { bufferMinutes: 10, kinds: {}, levels: {} } as unknown as AlarmSettingsDraft;
  const estimate = { appointment: {} } as unknown as Estimate;
  const at = new Date('2026-10-20T00:00:00Z');

  // [api 함수 이름, 부르는 법, real.ts 함수 이름, real.ts가 받아야 할 인자]
  const cases: [string, () => Promise<unknown>, string, unknown[]][] = [
    ['listAppointments', () => api.listAppointments(), 'listAppointments', []],
    ['getDaySchedule', () => api.getDaySchedule(at), 'getDaySchedule', [at]],
    ['getAppointment', () => api.getAppointment('a1'), 'getAppointment', ['a1']],
    ['previewAlarms', () => api.previewAlarms('a1', edits), 'previewAlarms', ['a1', edits]],
    ['recordEdit', () => api.recordEdit({ screen: 'S01', field: 'scheduled_at', autoValue: 1, editedValue: 2 }), 'recordEdit', [{ screen: 'S01', field: 'scheduled_at', autoValue: 1, editedValue: 2 }]],
    ['listEditLogs', () => api.listEditLogs(), 'listEditLogs', []],
    ['setAppointmentEnabled', () => api.setAppointmentEnabled('a1', false), 'setAppointmentEnabled', ['a1', false]],
    ['setAlarmEnabled', () => api.setAlarmEnabled('a1', 'WAKE', true), 'setAlarmEnabled', ['a1', 'WAKE', true]],
    ['setIntensity', () => api.setIntensity('a1', 'sound', 2), 'setIntensity', ['a1', 'sound', 2]],
    ['saveAlarmSettings', () => api.saveAlarmSettings('a1', settings), 'saveAlarmSettings', ['a1', settings]],
    ['listPlaces', () => api.listPlaces('세종'), 'listPlaces', ['세종', undefined]],
    ['listPlaces (near)', () => api.listPlaces('세종', { lat: 37.5, lng: 127 }), 'listPlaces', ['세종', { lat: 37.5, lng: 127 }]],
    ['estimateAppointment', () => api.estimateAppointment(api.defaultDraft(at)), 'estimateAppointment', [expect.objectContaining({ place: '' })]], // 실데이터는 장소를 목록에서 고름
    ['createAppointment', () => api.createAppointment(estimate, 'AI 대화'), 'createAppointment', [estimate, 'AI 대화']],
    ['getRing', () => api.getRing('a1:WAKE'), 'getRing', []],
    ['startRing', () => api.startRing('a1', at), 'startRing', []],
    ['stopRing', () => api.stopRing('a1'), 'stopRing', []],
    ['snoozeRing', () => api.snoozeRing('a1', 5, at), 'snoozeRing', []],
    ['getSnooze', () => api.getSnooze(), 'getSnooze', []],
    ['cancelSnooze', () => api.cancelSnooze('a1'), 'cancelSnooze', ['a1']],
    ['dismissRing', () => api.dismissRing('a1', at), 'dismissRing', []],
    ['getWakeCheck', () => api.getWakeCheck('a1'), 'getWakeCheck', ['a1']],
    ['getWakeInProgress', () => api.getWakeInProgress(), 'getWakeInProgress', []],
    ['recheckRecentWakes', () => api.recheckRecentWakes(), 'recheckRecentWakes', []],
    ['promptWake', () => api.promptWake('a1', at), 'promptWake', []],
    ['confirmWake', () => api.confirmWake('a1', 'self', at), 'confirmWake', ['a1', 'self']], // 판정 시각(가짜 시나리오 시각)은 실데이터에서 안 씀
    ['getMorningPlan', () => api.getMorningPlan(), 'getMorningPlan', []],
    ['checkDepartNow', () => api.checkDepartNow('a1'), 'checkDepartNow', ['a1']],
    ['createStandaloneAlarm', () => api.createStandaloneAlarm({ at, level: 1 }), 'saveStandaloneAlarm', [{ at, level: 1 }]],
    ['updateStandaloneAlarm', () => api.updateStandaloneAlarm('s1', { enabled: false }), 'saveStandaloneAlarm', [{ enabled: false, alarmId: 's1' }]],
  ];

  it.each(cases)('%s', async (_name, invoke, realName, realArgs) => {
    mockIsMock = false;
    mockReal.mockResolvedValue(sentinel);
    await expect(invoke()).resolves.toBe(sentinel);
    expect(mockReal).toHaveBeenCalledTimes(1);
    expect(mockReal).toHaveBeenCalledWith(realName, ...realArgs);
  });

  it('실데이터에서 새 일정의 장소는 비어 있음(목록에서 고름) — 가짜 데이터는 첫 장소', () => {
    expect(api.defaultDraft(at).place).toBe('학교 도서관');
    mockIsMock = false;
    expect(api.defaultDraft(at).place).toBe('');
  });

  it('가짜 모드에서는 읽기 함수가 real.ts를 부르지 않고 목업을 읽음', async () => {
    await api.listAppointments();
    await api.getDaySchedule(at);
    await api.listEditLogs();
    await api.listPlaces();
    await api.getSnooze();
    await api.getWakeInProgress();
    await api.getMorningPlan();
    await api.checkDepartNow('a1');
    await expect(api.recheckRecentWakes()).resolves.toEqual([]); // 가짜 모드는 시연 버튼으로 넘기므로 다시 판정하지 않음
    expect(mockReal).not.toHaveBeenCalled();
  });

  it('일정 없는 알람은 가짜 데이터에 둘 자리가 없어 이유를 알림', async () => {
    await expect(api.createStandaloneAlarm({ at })).rejects.toBeInstanceOf(UserError);
    await expect(api.updateStandaloneAlarm('s1', { enabled: false })).rejects.toBeInstanceOf(UserError);
    expect(mockReal).not.toHaveBeenCalled();
  });
});
