import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import * as api from '../api';
import { nearestPreviewAlarm, nextRingKind, parsePreviewAlarmId, previewRingOf } from '../ringPreview';
import type { Appointment } from '../types';

// 웹 실데이터 울림 미리보기 — 저장된 일정으로 울림 · 기상 확인 화면을 이어 보고, 서버(real.ts)의 울림 · 기상 기록 함수는 부르지 않음
let mockIsMock = false;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const at = (hm: string) => new Date(`2026-11-04T${hm}:00+09:00`);
const appt = (id: string, over: Partial<Appointment> = {}): Appointment =>
  ({
    id,
    title: '캡스톤 회의',
    at: at('10:00'),
    place: '공학관',
    bufferMinutes: 10,
    importance: 'NORMAL',
    items: [],
    level: 1,
    alarms: [
      { id: 'u-wake', kind: 'WAKE', at: at('08:30'), enabled: true },
      { id: 'u-prep', kind: 'PREPARE', at: at('08:50'), enabled: true },
      { id: 'u-depart', kind: 'DEPARTURE', at: at('09:20'), enabled: true },
      { id: 'u-arrive', kind: 'ARRIVE', at: at('09:50'), enabled: true },
    ],
    ...over,
  }) as Appointment;

const mockGetAppointment = jest.fn<(id: string) => Promise<Appointment | null>>();
const mockList = jest.fn<() => Promise<Appointment[]>>();
const mockRealRing = jest.fn<(name: string) => Promise<unknown>>();
jest.mock('../real', () => ({
  getAppointment: (id: string) => mockGetAppointment(id),
  listAppointments: () => mockList(),
  ...Object.fromEntries(['getRing', 'dismissRing', 'getWakeCheck', 'promptWake', 'confirmWake'].map((name) => [name, () => mockRealRing(name)])),
}));

beforeEach(() => {
  mockIsMock = false;
  mockGetAppointment.mockReset();
  mockGetAppointment.mockImplementation(async (id) => appt(id));
  mockList.mockReset();
  mockList.mockResolvedValue([]);
  mockRealRing.mockReset();
  mockRealRing.mockResolvedValue(null);
});

describe('미리보기 알람 id', () => {
  it('`일정 id:종류`만 미리보기로 읽음 — 실데이터 알람 id(UUID) · 도착은 아님', () => {
    expect(parsePreviewAlarmId('p1:WAKE')).toEqual({ appointmentId: 'p1', kind: 'WAKE' });
    expect(parsePreviewAlarmId('6b1f2c4e-0d7a-4a59-9a43-2f0c8d1e5b77')).toBeNull();
    expect(parsePreviewAlarmId('p1:ARRIVE')).toBeNull();
  });

  it('다음 알람 = 같은 일정에서 켜진 다음 종류 (꺼진 알람은 건너뜀)', () => {
    const a = appt('p1');
    expect(nextRingKind(a, 'WAKE')).toBe('PREPARE');
    expect(nextRingKind(a, 'DEPARTURE')).toBeNull();
    const noPrepare = appt('p1', { alarms: a.alarms.map((x) => (x.kind === 'PREPARE' ? { ...x, enabled: false } : x)) });
    expect(nextRingKind(noPrepare, 'WAKE')).toBe('DEPARTURE');
  });
});

describe('울림 화면 값 (previewRingOf)', () => {
  it('저장된 알람 시각 · 출발 시각 · 미루기 처음부터', () => {
    const ring = previewRingOf(appt('p1'), 'PREPARE');
    expect(ring).toMatchObject({ alarmId: 'p1:PREPARE', kind: 'PREPARE', at: at('08:50'), departAt: at('09:20'), snoozeCount: 0, important: true });
  });

  it('꺼진 알람은 null', () => {
    const a = appt('p1');
    expect(previewRingOf(appt('p1', { alarms: a.alarms.filter((x) => x.kind !== 'WAKE') }), 'WAKE')).toBeNull();
  });
});

describe('실데이터 모드에서 미리보기 흐름 (api)', () => {
  it('울림 → 해제 → 기상 확인 → 자동 판정까지 서버 함수를 안 부름', async () => {
    const ring = await api.getRing('w1:WAKE');
    expect(ring?.at).toEqual(at('08:30'));
    await api.dismissRing('w1:WAKE', ring!.at);
    const check = await api.getWakeCheck('w1:WAKE');
    expect(check).toMatchObject({ alarmId: 'w1:WAKE', appointmentTitle: '캡스톤 회의', phase: 'observing', groupId: null, confirmed: null });
    await api.confirmWake('w1:WAKE', 'auto', new Date());
    expect((await api.getWakeCheck('w1:WAKE'))?.confirmed?.how).toBe('auto');
    expect(mockRealRing).not.toHaveBeenCalled();
  });

  it('다시 잠들면 확인 알림 → 직접 응답으로 확정', async () => {
    await api.dismissRing('w2:WAKE', at('08:30'));
    await api.promptWake('w2:WAKE', new Date());
    expect((await api.getWakeCheck('w2:WAKE'))?.phase).toBe('prompt');
    await api.confirmWake('w2:WAKE', 'self', new Date());
    expect((await api.getWakeCheck('w2:WAKE'))?.confirmed?.how).toBe('self');
  });

  it('확정한 뒤 다시 울려 보면 기상 확인이 처음부터 (시연 버튼이 다시 나옴)', async () => {
    await api.dismissRing('w4:WAKE', at('08:30'));
    await api.confirmWake('w4:WAKE', 'auto', new Date());
    expect((await api.getWakeCheck('w4:WAKE'))?.confirmed).not.toBeNull();
    await api.dismissRing('w4:WAKE', at('08:30'));
    expect(await api.getWakeCheck('w4:WAKE')).toMatchObject({ phase: 'observing', confirmed: null });
  });

  it('끄기 전에는 기상 확인 없음, 실데이터 알람 id는 그대로 서버 함수로', async () => {
    expect(await api.getWakeCheck('w3:WAKE')).toBeNull();
    await api.getRing('6b1f2c4e-0d7a-4a59-9a43-2f0c8d1e5b77');
    await api.dismissRing('6b1f2c4e-0d7a-4a59-9a43-2f0c8d1e5b77', at('08:30'));
    expect(mockRealRing.mock.calls.map(([name]) => name)).toEqual(['getRing', 'dismissRing']);
  });

  it('준비를 끄면 다음은 출발, 출발 뒤에는 없음', async () => {
    expect(await api.nextPreviewRing('p1:PREPARE')).toEqual({ id: 'p1:DEPARTURE', kind: 'DEPARTURE', at: at('09:20') });
    expect(await api.nextPreviewRing('p1:DEPARTURE')).toBeNull();
  });
});

describe('가장 가까운 저장 알람 (nearestPreviewAlarm)', () => {
  const day = (id: string, hm: string[], over: Partial<Appointment> = {}) =>
    appt(id, {
      alarms: [
        { id: `${id}-w`, kind: 'WAKE', at: at(hm[0]), enabled: true },
        { id: `${id}-p`, kind: 'PREPARE', at: at(hm[1]), enabled: true },
        { id: `${id}-d`, kind: 'DEPARTURE', at: at(hm[2]), enabled: true },
      ],
      ...over,
    });
  const noon = at('12:00');

  it('앞으로 울릴 것 중 가장 이른 알람', () => {
    const list = [day('late', ['13:00', '13:20', '13:40']), day('soon', ['12:10', '12:30', '12:50'])];
    expect(nearestPreviewAlarm(list, noon, null)).toMatchObject({ kind: 'WAKE', appointment: { id: 'soon' } });
  });

  it('종류가 정해져 있으면 그 종류만 — 더 가까운 다른 종류가 있어도', () => {
    const list = [day('a', ['12:10', '12:30', '12:50']), day('b', ['14:00', '14:20', '14:40'])];
    expect(nearestPreviewAlarm(list, noon, 'DEPARTURE')).toMatchObject({ kind: 'DEPARTURE', appointment: { id: 'a' } });
  });

  it('그 종류가 하나도 없으면 아무 종류나, 앞으로 울릴 게 없으면 가장 최근 것', () => {
    const onlyDepart = [day('a', ['08:00', '08:20', '08:40'], { alarms: [{ id: 'x', kind: 'DEPARTURE', at: at('08:40'), enabled: true }] })];
    expect(nearestPreviewAlarm(onlyDepart, noon, 'WAKE')).toMatchObject({ kind: 'DEPARTURE' });
    const past = [day('old', ['06:00', '06:20', '06:40']), day('recent', ['09:00', '09:20', '09:40'])];
    expect(nearestPreviewAlarm(past, noon, null)).toMatchObject({ kind: 'DEPARTURE', appointment: { id: 'recent' } });
  });

  it('꺼진 알람 · 도착은 건너뛰고, 없으면 null', () => {
    const off = day('a', ['13:00', '13:20', '13:40'], {
      alarms: [
        { id: 'w', kind: 'WAKE', at: at('13:00'), enabled: false },
        { id: 'r', kind: 'ARRIVE', at: at('13:30'), enabled: true },
      ],
    });
    expect(nearestPreviewAlarm([off], noon, null)).toBeNull();
    expect(nearestPreviewAlarm([], noon, null)).toBeNull();
  });
});

describe('웹 실데이터에서 누른 알람을 못 찾을 때 (api.getRing)', () => {
  beforeEach(() => {
    mockGetAppointment.mockImplementation(async (id) => (id === 'a1' ? null : appt(id)));
    mockList.mockResolvedValue([appt('saved')]);
  });

  it('웹: 가짜 데이터 주소(a1:WAKE) · 주소 없는 실데이터 id도 가장 가까운 저장 알람이 바로 울림, 서버 쓰기 함수는 안 부름', async () => {
    const web = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      expect(await api.getRing('a1:WAKE')).toMatchObject({ alarmId: 'saved:WAKE', kind: 'WAKE', at: at('08:30') });
      expect(await api.getRing('6b1f2c4e-0d7a-4a59-9a43-2f0c8d1e5b77')).toMatchObject({ kind: expect.any(String) });
      expect(mockRealRing.mock.calls.map(([name]) => name)).toEqual(['getRing']);
    } finally {
      web.restore();
    }
  });

  it('폰: 못 찾으면 그대로 null (미리보기로 안 바뀜)', async () => {
    expect(await api.getRing('a1:WAKE')).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
  });
});
