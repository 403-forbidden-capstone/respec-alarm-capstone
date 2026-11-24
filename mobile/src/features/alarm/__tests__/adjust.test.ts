import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import { adjustEstimate, autoTime, isManualTime, linkWakeTimes, manualTimes, moveAlarm, orderError, resetAlarm, sameEdits, shownPreview, timeInputsChanged } from '../adjust';
import type { AlarmEdits, AlarmKind, AlarmPreview, AlarmTime, Estimate } from '../types';

const at = (minutes: number) => kst(22, minutes);
const alarm = (kind: AlarmKind, minutes: number): AlarmTime => ({ id: `a1:${kind}`, kind, at: at(minutes), enabled: true });
// 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50
const chain = () => [alarm('WAKE', 480), alarm('PREPARE', 510), alarm('DEPARTURE', 540), alarm('ARRIVE', 590)];
const times = (alarms: AlarmTime[]) => alarms.map((x) => `${x.kind} ${formatTime(x.at)}${isManualTime(x) ? '*' : ''}`);

describe('알람 시각 직접 고르기 — 기상을 옮기면 준비도 같은 간격으로 (D42 C · D43, F5)', () => {
  it('기상을 앞당기면 준비도 같은 만큼 앞당겨지고, 출발 · 도착 목표는 그대로. 직접 고른 기상에만 표시', () => {
    const moved = moveAlarm(chain(), 'WAKE', at(450));
    expect(times(moved)).toEqual(['WAKE 오전 7:30*', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(autoTime(moved[0])).toEqual(at(480)); // 자동 계산값은 그대로 남김
  });

  it('기상을 늦춰도 같은 간격 — 준비도 같이 늦어짐', () => {
    expect(times(moveAlarm(chain(), 'WAKE', at(495)))).toEqual(['WAKE 오전 8:15*', 'PREPARE 오전 8:45', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
  });

  it('준비 · 출발은 그 알람만 옮김 (출발을 옮겨도 준비 · 도착 목표는 그대로)', () => {
    expect(times(moveAlarm(chain(), 'PREPARE', at(520)))).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:40*', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(times(moveAlarm(chain(), 'DEPARTURE', at(530)))).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 8:50*', 'ARRIVE 오전 9:50']);
  });

  it('자동 계산값과 같은 시각으로 옮기면 직접 고른 것이 아님 (다시 자동)', () => {
    const once = moveAlarm(chain(), 'PREPARE', at(520));
    expect(times(moveAlarm(once, 'PREPARE', at(510)))).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
  });

  it('직접 고른 준비가 있으면 기상을 옮길 때 같이 옮기고, 자동값과의 차이는 그대로', () => {
    const prepared = moveAlarm(chain(), 'PREPARE', at(520)); // 준비를 10분 늦게
    const moved = moveAlarm(prepared, 'WAKE', at(450));
    expect(times(moved)).toEqual(['WAKE 오전 7:30*', 'PREPARE 오전 8:10*', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(autoTime(moved[1])).toEqual(at(480)); // 준비의 자동값도 기상 뒤로 계산하므로 같이 옮겨 감
  });

  it('여러 번 나눠 옮겨도 합친 간격만큼 (시 · 분을 한 칸씩 올릴 때)', () => {
    let alarms = chain();
    for (const minute of [481, 482, 483, 470, 450]) alarms = moveAlarm(alarms, 'WAKE', at(minute));
    expect(times(alarms)).toEqual(['WAKE 오전 7:30*', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
  });

  it('자동으로 되돌리면 기상과 따라온 준비가 함께 원래대로', () => {
    const moved = moveAlarm(chain(), 'WAKE', at(450));
    expect(times(resetAlarm(moved, 'WAKE'))).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(resetAlarm(chain(), 'WAKE')).toEqual(chain()); // 이미 자동이면 그대로
  });

  it('없는 종류를 옮기려 하면 그대로 (기상 알람이 없는 일정)', () => {
    const noWake = chain().filter((x) => x.kind !== 'WAKE');
    expect(moveAlarm(noWake, 'WAKE', at(450))).toBe(noWake);
  });

  it('직접 고른 시각만 모음 — 따라온 준비는 자동이라 빠짐', () => {
    expect(manualTimes(moveAlarm(chain(), 'WAKE', at(450)))).toEqual({ WAKE: at(450) });
    expect(manualTimes(moveAlarm(moveAlarm(chain(), 'WAKE', at(450)), 'PREPARE', at(490)))).toEqual({ WAKE: at(450), PREPARE: at(490) });
    expect(manualTimes(chain())).toEqual({});
  });
});

describe('알람 순서 확인 — 기상 ≤ 준비 ≤ 출발 ≤ 도착 목표', () => {
  it('맞으면 null, 같은 시각은 허용', () => {
    expect(orderError(chain())).toBeNull();
    expect(orderError(moveAlarm(chain(), 'PREPARE', at(540)))).toBeNull(); // 준비 = 출발
    expect(orderError([alarm('PREPARE', 510), alarm('DEPARTURE', 540), alarm('ARRIVE', 590)])).toBeNull(); // 기상 알람 없는 일정
    expect(orderError([])).toBeNull(); // 알람 없는 일정
  });

  it('기상을 크게 늦추면 따라온 준비가 출발을 넘어 순서가 뒤집힘', () => {
    expect(orderError(moveAlarm(chain(), 'WAKE', at(600)))).toBe('출발 시각이 준비보다 빠를 수 없어요'); // 기상 10:00 · 준비 10:30 · 출발 9:00
  });

  it('뒤집히면 어느 둘이 어긋났는지 짧게', () => {
    expect(orderError(moveAlarm(chain(), 'PREPARE', at(470)))).toBe('준비 시각이 기상보다 빠를 수 없어요');
    expect(orderError(moveAlarm(chain(), 'DEPARTURE', at(500)))).toBe('출발 시각이 준비보다 빠를 수 없어요');
    expect(orderError(moveAlarm(chain(), 'DEPARTURE', at(600)))).toBe('출발 시각이 도착 목표(오전 9:50)보다 늦을 수 없어요');
  });

  it('기상 알람이 없으면 준비부터 비교', () => {
    const noWake = chain().filter((x) => x.kind !== 'WAKE');
    expect(orderError(moveAlarm(noWake, 'PREPARE', at(560)))).toBe('출발 시각이 준비보다 빠를 수 없어요');
  });
});

describe('H05 확인 시트에서 시각 고치기', () => {
  const estimate = { appointment: { alarms: chain() } } as unknown as Estimate;

  it('칩을 고치면 그 알람(기상이면 준비까지)만 바뀌고, null이면 자동으로', () => {
    const moved = adjustEstimate(estimate, 'WAKE', at(450));
    expect(times(moved.appointment.alarms)).toEqual(['WAKE 오전 7:30*', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(times(adjustEstimate(moved, 'WAKE', null).appointment.alarms)).toEqual(times(chain()));
    expect(estimate.appointment.alarms).toEqual(chain()); // 원본은 건드리지 않음
  });
});

describe('H03 초안 비교', () => {
  const base: AlarmEdits = { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} };

  it('알람 시각을 밀어 움직이는 입력만 따로 봄 — 직접 고른 시각은 뺌', () => {
    expect(timeInputsChanged(base, { ...base, times: { WAKE: at(450) } })).toBe(false);
    for (const patch of [{ bufferMinutes: 5 }, { origin: '세종대학교' }, { transport: 'CAR' as const }, { travelMinutes: 40 }, { prepareMinutes: 70 }]) {
      expect(timeInputsChanged(base, { ...base, ...patch })).toBe(true);
    }
  });

  it('같은 초안인지는 직접 고른 시각까지 봄', () => {
    expect(sameEdits(base, { ...base, times: {} })).toBe(true);
    expect(sameEdits({ ...base, times: { WAKE: at(450) } }, { ...base, times: { WAKE: at(450) } })).toBe(true);
    expect(sameEdits({ ...base, times: { WAKE: at(450) } }, { ...base, times: { WAKE: at(451) } })).toBe(false);
    expect(sameEdits(base, { ...base, times: { PREPARE: at(500) } })).toBe(false);
  });
});

describe('H03에 보일 알람 — 입력을 안 바꾸면 저장된 값', () => {
  const edits: AlarmEdits = { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} };
  const preview = (alarms: AlarmTime[], extra = {}): AlarmPreview => ({ alarms, travelMinutes: 40, travelSource: '', autoTravelMinutes: 40, predictedPrepMinutes: 30, autoPredictedPrepMinutes: 30, ...extra });
  const saved = preview(chain());
  const recalculated = preview([alarm('WAKE', 497), alarm('PREPARE', 527), alarm('DEPARTURE', 540), alarm('ARRIVE', 590)], { prepareSampleCount: 6 });

  it('입력을 안 바꿨으면 다시 계산한 값이 달라도 저장된 시각을 보이고, 기록 기반 줄만 다시 계산한 값에서 가져옴', () => {
    const shown = shownPreview(edits, edits, saved, recalculated);
    expect(times(shown.alarms)).toEqual(times(chain()));
    expect(shown.prepareSampleCount).toBe(6);
  });

  it('입력을 바꾸면 다시 계산한 값을 보임', () => {
    expect(shownPreview({ ...edits, bufferMinutes: 5 }, edits, saved, recalculated)).toBe(recalculated);
    expect(shownPreview({ ...edits, times: { WAKE: at(450) } }, edits, saved, recalculated)).toBe(recalculated);
  });
});

describe('같은 날 일정 없는 기상 합치기 (linkWakeTimes)', () => {
  const chain = (): AlarmTime[] => [
    { id: 'w', kind: 'WAKE', at: kst(23, 660), enabled: true },
    { id: 'p', kind: 'PREPARE', at: kst(23, 690), enabled: true },
    { id: 'd', kind: 'DEPARTURE', at: kst(23, 720), enabled: true },
  ];

  it('기상 = 그 알람 시각, 준비는 보이던 시각에 고정 — 오후 1시 약속의 준비가 아침으로 당겨지지 않음 · 다른 직접 고른 시각은 그대로', () => {
    const times = linkWakeTimes(chain(), { DEPARTURE: kst(23, 715) }, kst(23, 480));
    expect(times).toEqual({ WAKE: kst(23, 480), PREPARE: kst(23, 690), DEPARTURE: kst(23, 715) });
    expect(orderError(chain().map((x) => ({ ...x, at: (times as Record<string, Date>)[x.kind] ?? x.at })))).toBeNull(); // 기상 8:00 ≤ 준비 11:30 ≤ 출발
  });

  it('합칠 기상이 준비보다 늦으면 준비는 고정하지 않음 (기상 뒤로 따라옴) · 준비가 없으면 기상만', () => {
    expect(linkWakeTimes(chain(), {}, kst(23, 700))).toEqual({ WAKE: kst(23, 700) });
    expect(linkWakeTimes(chain().filter((x) => x.kind !== 'PREPARE'), {}, kst(23, 480))).toEqual({ WAKE: kst(23, 480) });
  });
});
