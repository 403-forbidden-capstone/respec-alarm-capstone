import { afterEach, describe, expect, it } from '@jest/globals';

import { prepareRecentLabel, prepareSourceLabel } from '@shared/calc/prepare.ts';

import { formatTime } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';
import { memberState } from '@/mocks/calc';
import { db, kst } from '@/mocks/data';

import {
  cancelSnooze,
  confirmWake,
  createAppointment,
  defaultDraft,
  dismissRing,
  draftAt,
  estimateAppointment,
  getAppointment,
  getDaySchedule,
  getNextAlarm,
  getRing,
  getSnooze,
  getWakeCheck,
  getWakeInProgress,
  listAppointments,
  listEditLogs,
  listOccurrences,
  previewAlarms,
  promptWake,
  recordEdit,
  saveAlarmSettings,
  snoozeRing,
  startRing,
  stopRing,
} from '../api';
import { adjustEstimate } from '../adjust';
import { EVERY_DAY, WEEKDAYS_ONLY } from '../repeat';
import { changedAlarms, needsMoveConfirm } from '../schedule';
import type { AlarmSettingsDraft, AppointmentDraft } from '../types';

const SEEDS = db.appointments.map((a) => ({ ...a })); // 시드 일정 — 테스트가 고치거나 새로 만든 일정은 매번 되돌림
const WAKE = 'a1:WAKE'; // 팀 주간회의 기상 오전 8:00
const morning = kst(22, 475); // 오전 7:55
const me = () => memberState('me', morning).text;

// 저장된 값 그대로의 H03 초안 — 여기서 고칠 곳만 바꿔 저장
const settingsOf = async (id: string): Promise<AlarmSettingsDraft> => {
  const a = (await getAppointment(id))!;
  return {
    ...a.edits,
    kinds: Object.fromEntries(a.alarms.filter((x) => x.kind !== 'ARRIVE').map((x) => [x.kind, x.enabled])),
    levels: { sound: null, voice: null, vibration: null },
  };
};
const labels = () => db.events.map((e) => `${formatTime(e.at)} ${e.label}`);

afterEach(() => {
  db.appointments.splice(0, db.appointments.length, ...SEEDS.map((a) => ({ ...a })));
  db.editLogs.length = 0;
  db.snoozes = {};
  db.snoozeCounts = {};
  db.disabledKinds.clear();
  db.disabledAppointments.clear();
  db.intensityOverrides = {};
  db.wakeSensitivity = 'NORMAL';
  db.wakeMargin = 'NORMAL';
  db.wake = { alarmId: null, phase: 'idle', ringAt: null, dismissedAt: null, usage: 0, recent: 0 };
  db.events.length = 0;
  db.me.wakeAt = null;
  for (const id of Object.keys(db.wakeConfirmations)) delete db.wakeConfirmations[id];
});

describe('H05 시간 칸', () => {
  it('고른 시각을 그날 시각으로', () => {
    expect(formatTime(draftAt(kst(23, 0), '14:00'))).toBe('오후 2:00');
    expect(formatTime(draftAt(kst(23, 0), '9:05'))).toBe('오전 9:05');
  });

  it('비었거나 틀리면 목업처럼 14:00', () => {
    expect(formatTime(draftAt(kst(23, 0), ''))).toBe('오후 2:00');
    expect(formatTime(draftAt(kst(23, 0), '25:99'))).toBe('오후 2:00');
  });

  it('5분 단위가 아닌 시각(대화에서 찾은 14:07)도 그대로', () => {
    expect(formatTime(draftAt(kst(23, 0), '14:07'))).toBe('오후 2:07');
  });

  it('처음 입력값 — 일정명 · 준비물은 비고, 날짜는 넘겨 받은 날 오후 2시 (지났으면 다음 정각)', () => {
    const d = defaultDraft(kst(22, 0), morning);
    expect([d.title, d.items, d.time, d.date]).toEqual(['', '', '14:00', kst(22, 0)]);
    expect(defaultDraft(kst(22, 0), kst(22, 15 * 60 + 20)).time).toBe('16:00');
  });
});

describe('H05 반복 저장 (D44)', () => {
  const draftOn = (repeat: Weekday[]): AppointmentDraft => ({ ...defaultDraft(kst(24, 0), morning), title: '스터디', repeat });

  it('요일을 고르면 반복 규칙(RRULE)으로 저장되고, 화면 글자는 규칙에서 만든다', async () => {
    const cases: [Weekday[], string | null, string][] = [
      [[], null, '반복 없음'],
      [['수', '월'], 'FREQ=WEEKLY;BYDAY=MO,WE', '매주 월 · 수'],
      [[...WEEKDAYS_ONLY], 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '평일'],
      [[...EVERY_DAY], 'FREQ=DAILY', '매일'],
    ];
    for (const [repeat, rule, label] of cases) {
      const saved = await createAppointment(await estimateAppointment(draftOn(repeat)));
      expect([saved.recurrenceRule, saved.repeatLabel]).toEqual([rule, label]);
      expect(db.appointments.find((a) => a.id === saved.id)!.recurrenceRule).toBe(rule);
    }
  });

  it('시드 일정은 규칙에서 읽은 글자가 이전과 같음 (매주 목요일 · 반복 없음)', async () => {
    expect((await getAppointment('a1'))!.repeatLabel).toBe('매주 목요일');
    expect((await getAppointment('a2'))!.repeatLabel).toBe('반복 없음');
    expect((await getAppointment('a3'))!.repeatLabel).toBe('매주 금요일');
  });
});

describe('H05 그날 첫 일정만 기상 알람 (약속 시각 기준, 서버와 같은 hasEarlierWake)', () => {
  const kindsOf = (alarms: { kind: string }[]) => alarms.map((x) => x.kind);
  const on23 = (time: string): AppointmentDraft => ({ ...defaultDraft(kst(23, 0), morning), title: '스터디', time });

  it('9시 수업(기상 있음)보다 이른 8:30 일정은 그날 첫 일정이라 기상 알람이 있음 — 수업의 기상 알람이 더 일찍 울려도', async () => {
    const e = await estimateAppointment(on23('08:30'));
    expect(kindsOf(e.appointment.alarms)).toContain('WAKE');
  });

  it('9시 수업 뒤의 14:00 일정은 기상 없이 준비부터', async () => {
    const e = await estimateAppointment(on23('14:00'));
    expect(kindsOf(e.appointment.alarms)).not.toContain('WAKE');
  });

  it('앞선 일정의 기상 알람을 꺼 두면 세지 않음', async () => {
    db.disabledKinds.add('a3:WAKE');
    try {
      const e = await estimateAppointment(on23('14:00'));
      expect(kindsOf(e.appointment.alarms)).toContain('WAKE');
    } finally {
      db.disabledKinds.delete('a3:WAKE');
    }
  });
});

describe('H05 · H03 준비 시간 계산 (학습 루프 기초 a — 서버 calc와 같은 규칙)', () => {
  const on23 = (time: string): AppointmentDraft => ({ ...defaultDraft(kst(23, 0), morning), title: '스터디', time });

  it('그날 첫 일정은 첫 값 50 + 개인 보정 10 = 60분, 내 기록 10건 → "내 기록 기반 10건"', async () => {
    const e = await estimateAppointment(on23('08:30'));
    expect([e.commonP80, e.correction, e.appointment.predictedPrepMinutes, e.sampleCount, e.sameDayWake]).toEqual([50, 10, 60, 10, false]);
    expect(prepareSourceLabel(e.sampleCount)).toBe('내 기록 기반 10건');
  });

  it('같은 날 두 번째 일정은 개인 보정 없이 공통 15분 그대로 (예전에는 가짜 기록 보정 +10분이 붙어 25분)', async () => {
    const e = await estimateAppointment(on23('14:00'));
    expect([e.commonP80, e.correction, e.appointment.predictedPrepMinutes, e.sampleCount, e.sameDayWake]).toEqual([15, 0, 15, 0, true]);
  });

  it('H03 미리 보기도 같은 기록 수를 줌: 기상 있는 일정은 10건, 기상 없는 일정은 0건', async () => {
    const edits = (await getAppointment('a1'))!.edits;
    expect((await previewAlarms('a1', edits)).prepareSampleCount).toBe(10);
    expect((await previewAlarms('a2', (await getAppointment('a2'))!.edits)).prepareSampleCount).toBe(0);
  });
});

describe('학습 루프 기초 b — 가짜 모드도 서버와 같은 잠귀 · 깨우는 여유 규칙 (#272)', () => {
  const on23 = (time: string, importance: AppointmentDraft['importance'] = 'NORMAL'): AppointmentDraft => ({ ...defaultDraft(kst(23, 0), morning), title: '스터디', time, importance });
  const prepareOf = async (margin: 'TIGHT' | 'NORMAL' | 'LOOSE', importance: AppointmentDraft['importance'] = 'NORMAL', time = '08:30') => {
    db.wakeMargin = margin;
    return (await estimateAppointment(on23(time, importance))).appointment.predictedPrepMinutes;
  };

  it('프로필 값이 없으면(기본) 잠귀 · 여유 모두 보통 — 예전과 같은 60분', async () => {
    expect(await prepareOf('NORMAL')).toBe(60);
  });

  it('같은 기록에서 빠듯 < 보통 < 넉넉, 매우 중요는 한 단계 위, 두 번째 일정은 15분 그대로', async () => {
    const [tight, normal, loose] = [await prepareOf('TIGHT'), await prepareOf('NORMAL'), await prepareOf('LOOSE')];
    expect(tight).toBeLessThan(normal);
    expect(normal).toBeLessThan(loose);
    expect(await prepareOf('TIGHT', 'HIGH')).toBe(normal);
    expect(await prepareOf('NORMAL', 'HIGH')).toBe(loose);
    expect(await prepareOf('LOOSE', 'HIGH')).toBe(loose);
    for (const margin of ['TIGHT', 'LOOSE'] as const) expect(await prepareOf(margin, 'HIGH', '14:00')).toBe(15);
  });

  it('잠귀 무거움(HEAVY)이면 보통 일정도 강도 자동 값이 강, 가벼움 · 보통이면 보통(약 아님)', async () => {
    expect((await getAppointment('a2'))!.intensity.auto).toBe(1); // 보통 일정 + 지각 1회
    db.wakeSensitivity = 'HEAVY';
    expect((await getAppointment('a2'))!.intensity.auto).toBe(2);
    expect((await getAppointment('a1'))!.intensity.axes.sound.level).toBe(2);
  });

  it('H03 미리 보기: 최근 5번(최신순) — 기상 있는 일정만, 문구는 오래된 것 → 최신', async () => {
    const preview = await previewAlarms('a1', (await getAppointment('a1'))!.edits);
    expect(preview.prepareRecent).toEqual([90, 70, 62, 55, 48]);
    expect(prepareRecentLabel(preview.prepareRecent ?? [])).toBe('최근 5번 48 · 55 · 62 · 70 · 90분');
    expect((await previewAlarms('a2', (await getAppointment('a2'))!.edits)).prepareRecent).toEqual([]);
  });
});

describe('H05 알람 종류 고르기 · 알람 없는 일정 (D46)', () => {
  const draftWith = (alarms: Partial<AppointmentDraft['alarms']>): AppointmentDraft => ({
    ...defaultDraft(kst(24, 0), morning),
    title: '스터디',
    alarms: { WAKE: true, PREPARE: true, DEPARTURE: true, ...alarms },
  });
  const kindsOf = (alarms: { kind: string }[]) => alarms.map((x) => x.kind);

  it('고른 종류만 만들고, 도착 목표는 울리는 알람이 하나라도 있을 때 붙음', async () => {
    const all = await estimateAppointment(draftWith({}));
    expect(kindsOf(all.appointment.alarms)).toEqual(['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);

    const noWake = await estimateAppointment(draftWith({ WAKE: false }));
    expect(kindsOf(noWake.appointment.alarms)).toEqual(['PREPARE', 'DEPARTURE', 'ARRIVE']);
    // 고르지 않은 종류가 있어도 나머지 알람 시각은 그대로
    const time = (e: typeof all, kind: string) => e.appointment.alarms.find((x) => x.kind === kind)!.at;
    expect(time(noWake, 'PREPARE')).toEqual(time(all, 'PREPARE'));
    expect(time(noWake, 'DEPARTURE')).toEqual(time(all, 'DEPARTURE'));

    const onlyDepart = await createAppointment(await estimateAppointment(draftWith({ WAKE: false, PREPARE: false })));
    expect(kindsOf(onlyDepart.alarms)).toEqual(['DEPARTURE', 'ARRIVE']);
    expect(db.appointments[db.appointments.length - 1].kinds).toEqual(['DEPARTURE']);
  });

  it('모두 끄면 알람 없는 일정 — 알람 목록 · 알람 설정에는 없고 하루 일정에만 보임', async () => {
    const saved = await createAppointment(await estimateAppointment(draftWith({ WAKE: false, PREPARE: false, DEPARTURE: false })));
    expect(saved.alarms).toEqual([]);
    expect((await listAppointments()).map((a) => a.id)).not.toContain(saved.id);
    expect(await getAppointment(saved.id)).toBeNull();
    const day = await getDaySchedule(kst(24, 0));
    expect(day.map((x) => [x.appointmentId, x.title, x.hasAlarm])).toEqual([[saved.id, '스터디', false]]);
    expect(await getWakeCheck()).toBeNull(); // 기상 알람 없는 일정이 있어도 기상 확인은 그대로
  });

  it('시드의 알람 없는 일정(치과 예약)도 같은 모양의 일정 — 하루 일정에는 있고 알람 목록에는 없음', async () => {
    const day = await getDaySchedule(kst(22, 0));
    expect(day.map((x) => [x.title, x.hasAlarm])).toEqual([
      ['팀 주간회의', true],
      ['치과 예약', false],
      ['저녁약속', true],
    ]);
    expect((await listAppointments()).map((a) => a.title)).toEqual(['팀 주간회의', '저녁약속', '수업', '영어 스터디']); // 영어 스터디 = 반복 묶음 한 장 (아래 H02 반복 묶음)
  });

  it('알람 없는 일정은 같은 날 기상 알람으로 세지 않음 — 뒤 일정이 기상 알람을 가짐', async () => {
    await createAppointment(await estimateAppointment(draftWith({ WAKE: false, PREPARE: false, DEPARTURE: false })));
    const later = { ...draftWith({}), time: '16:00' };
    const e = await estimateAppointment(later);
    expect([e.sameDayWake, kindsOf(e.appointment.alarms)[0]]).toEqual([false, 'WAKE']);

    // 앞 일정에 기상 알람이 있으면 지금처럼 외출 준비만
    db.appointments.splice(SEEDS.length);
    await createAppointment(await estimateAppointment(draftWith({})));
    const e2 = await estimateAppointment(later);
    expect([e2.sameDayWake, kindsOf(e2.appointment.alarms)[0]]).toEqual([true, 'PREPARE']);
  });

  it('H03의 "종류를 모두 끔"은 알람을 만들어 둔 채 끈 것 — 알람 목록에 남고 다시 켤 수 있음', async () => {
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), kinds: { WAKE: false, PREPARE: false, DEPARTURE: false } });
    const off = (await listAppointments()).find((a) => a.id === 'a1')!;
    expect([off.enabled, off.alarms.length]).toEqual([false, 4]);
    expect(await getAppointment('a1')).not.toBeNull();
  });
});

describe('H01 다음 알람 · 미루기 · 기상 확인 다시 들어가기', () => {
  it('다음 알람은 앞으로 울릴 첫 알람 (아침 7:55면 8:00 기상)', async () => {
    const next = await getNextAlarm();
    expect([next!.appointment.id, formatTime(next!.alarm.at)]).toEqual(['a1', '오전 8:00']);
  });

  it('미루면 다시 울릴 시각과 함께 보이고, 취소하면 사라짐', async () => {
    expect(await getSnooze()).toBeNull();
    await startRing(WAKE, kst(22, 480));
    await snoozeRing(WAKE, 5, kst(22, 480));
    const snooze = await getSnooze();
    expect([snooze!.alarmId, snooze!.kind, snooze!.appointmentTitle, formatTime(snooze!.at)]).toEqual([WAKE, 'WAKE', '팀 주간회의', '오전 8:05']);
    await cancelSnooze(WAKE);
    expect(await getSnooze()).toBeNull();
  });

  it('다시 울리기 시작하거나 해제하면 미룸 표시가 끝남', async () => {
    await snoozeRing(WAKE, 5, kst(22, 480));
    await startRing(WAKE, kst(22, 485));
    expect(await getSnooze()).toBeNull();
    await snoozeRing('a1:PREPARE', 10, kst(22, 510));
    expect((await getSnooze())!.alarmId).toBe('a1:PREPARE');
    await dismissRing('a1:PREPARE', kst(22, 520));
    expect(await getSnooze()).toBeNull();
  });

  it('이미 시각이 지난 미룸은 안 보임', async () => {
    await snoozeRing(WAKE, 5, kst(22, 460)); // 7:40에 미룸 → 7:45 (지금 7:55)
    expect(await getSnooze()).toBeNull();
  });

  it('기상 알람을 끈 뒤 판정 중에만 기상 확인이 진행 중으로 보임', async () => {
    expect(await getWakeInProgress()).toBeNull();
    await startRing(WAKE, kst(22, 480));
    expect(await getWakeInProgress()).toBeNull();
    await dismissRing(WAKE, kst(22, 480));
    expect((await getWakeInProgress())!.alarmId).toBe(WAKE);
    await promptWake(WAKE, kst(22, 490));
    expect((await getWakeInProgress())!.phase).toBe('prompt');
    await confirmWake(WAKE, 'self', kst(22, 491));
    expect(await getWakeInProgress()).toBeNull();
  });
});

describe('H03 저장 — 여유 · 종류별 켜기 · 강도를 한 번에', () => {
  const base = () => settingsOf('a1');

  it('저장 전에는 아무것도 안 바뀌고, 저장하면 한 번에 반영', async () => {
    const draft = await base();
    const before = (await getAppointment('a1'))!;
    expect(before.intensity.axes.sound.manual).toBe(false);
    const result = await saveAlarmSettings('a1', {
      ...draft,
      bufferMinutes: 5,
      kinds: { ...draft.kinds, PREPARE: false },
      levels: { sound: 2, voice: null, vibration: 0 },
    });
    expect(result).toEqual({ turnedOff: false, turnedOn: false });
    const after = (await getAppointment('a1'))!;
    expect(after.bufferMinutes).toBe(5);
    expect(after.alarms.find((x) => x.kind === 'PREPARE')!.enabled).toBe(false);
    expect(after.intensity.axes.sound).toEqual({ level: 2, manual: true });
    expect(after.intensity.axes.voice.manual).toBe(false);
    expect(after.intensity.axes.vibration).toEqual({ level: 0, manual: true });
  });

  it('고른 강도를 자동으로 되돌림 (축별)', async () => {
    const draft = await base();
    await saveAlarmSettings('a1', { ...draft, levels: { sound: 2, voice: 1, vibration: null } });
    await saveAlarmSettings('a1', { ...draft, levels: { sound: null, voice: 1, vibration: null } });
    const after = (await getAppointment('a1'))!;
    expect([after.intensity.axes.sound.manual, after.intensity.axes.voice.manual]).toEqual([false, true]);
  });

  it('종류를 모두 끄면 일정 알람도 꺼지고, 하나를 다시 켜면 일정 알람도 켜짐', async () => {
    const draft = await base();
    const off = await saveAlarmSettings('a1', { ...draft, kinds: { WAKE: false, PREPARE: false, DEPARTURE: false } });
    expect(off).toEqual({ turnedOff: true, turnedOn: false });
    expect((await getAppointment('a1'))!.enabled).toBe(false);
    expect(await getNextAlarm()).not.toMatchObject({ appointment: { id: 'a1' } });

    const on = await saveAlarmSettings('a1', { ...draft, kinds: { WAKE: true, PREPARE: false, DEPARTURE: false } });
    expect(on).toEqual({ turnedOff: false, turnedOn: true });
    expect((await getAppointment('a1'))!.enabled).toBe(true);
  });

  it('종류를 안 바꾼 저장은 카드에서 켜고 끈 일정 상태를 건드리지 않음', async () => {
    const draft = await base();
    db.disabledAppointments.add('a1');
    await saveAlarmSettings('a1', { ...draft, bufferMinutes: 15 });
    expect((await getAppointment('a1'))!.enabled).toBe(false);
  });
});

describe('H03 여유 시간 1분 단위 (D12)', () => {
  it('여유를 1분 바꾸면 알람도 1분 움직여(5분 단위로 뭉치지 않음), 5분 미만이면 확인 없이 저장하고 5분부터 확인을 물음', async () => {
    const a = (await getAppointment('a1'))!; // 여유 10분 · 기상 오전 8:00
    const draft = await settingsOf('a1');
    const moved = async (bufferMinutes: number) => changedAlarms(a.alarms, (await previewAlarms('a1', { ...draft, bufferMinutes })).alarms);

    const one = await moved(11);
    expect(one.map((c) => [c.kind, formatTime(c.to)])).toEqual([['WAKE', '오전 7:59'], ['PREPARE', '오전 8:29'], ['DEPARTURE', '오전 8:59']]);
    expect(needsMoveConfirm(one)).toBe(false);
    expect(needsMoveConfirm(await moved(14))).toBe(false); // 4분
    expect(needsMoveConfirm(await moved(15))).toBe(true); // 5분
    expect(needsMoveConfirm(await moved(5))).toBe(true); // 줄여도 5분
    expect(needsMoveConfirm(await moved(7))).toBe(false); // 3분
    expect(await moved(10)).toEqual([]);
  });

  it('저장도 1분 단위 그대로 — 여유 13분이면 기상 오전 7:57', async () => {
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), bufferMinutes: 13 });
    const a = (await getAppointment('a1'))!;
    expect([a.bufferMinutes, formatTime(a.alarms[0].at)]).toEqual([13, '오전 7:57']);
  });
});

describe('H03 직접 고침 — 출발 위치 · 이동 수단 · 이동 · 준비 · 알람 시각 (D42 C)', () => {
  const brief = async (id = 'a1') => {
    const a = (await getAppointment(id))!;
    return [a.travelMinutes, a.travelSource, a.predictedPrepMinutes, ...a.alarms.map((x) => `${x.kind} ${formatTime(x.at)}${x.auto ? '*' : ''}`)];
  };

  it('이동 수단을 바꾸면 이동시간을 다시 계산해 알람이 움직임 (미리 보기도 같음)', async () => {
    const draft = await settingsOf('a1');
    const preview = await previewAlarms('a1', { ...draft, transport: 'CAR' });
    expect([preview.travelMinutes, preview.autoTravelMinutes, preview.travelSource]).toEqual([35, 35, '길찾기']);
    expect(preview.alarms.map((x) => formatTime(x.at))).toEqual(['오전 8:15', '오전 8:45', '오전 9:15', '오전 9:50']); // 출발 = 10:00 − 10 − 35
    expect(await brief()).toEqual([50, '길찾기 + 내 실측 3회', 60, 'WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']); // 저장 전에는 그대로

    await saveAlarmSettings('a1', { ...draft, transport: 'CAR' });
    expect(await brief()).toEqual([35, '길찾기', 60, 'WAKE 오전 8:15', 'PREPARE 오전 8:45', 'DEPARTURE 오전 9:15', 'ARRIVE 오전 9:50']);
    expect((await getAppointment('a1'))!.transport).toBe('CAR');
  });

  it('출발 위치를 집이 아닌 곳으로 바꾸면 이동시간이 줄어듦 (가짜 길찾기 규칙)', async () => {
    const draft = await settingsOf('a1');
    await saveAlarmSettings('a1', { ...draft, origin: '학교 도서관' });
    const a = (await getAppointment('a1'))!;
    expect([a.origin, a.travelMinutes]).toEqual(['학교 도서관', 25]);
  });

  it('출발 위치가 약속 장소와 같은 곳이면 이동시간이 가장 작은 값 5분 (가짜 길찾기 규칙)', async () => {
    const draft = await settingsOf('a1'); // a1의 약속 장소는 세종대학교
    const preview = await previewAlarms('a1', { ...draft, origin: '세종대학교' });
    expect([preview.travelMinutes, preview.autoTravelMinutes]).toEqual([5, 5]);
    const car = await previewAlarms('a1', { ...draft, origin: '세종대학교', transport: 'CAR' });
    expect(car.travelMinutes).toBe(5); // 이동 수단과 상관없이
  });

  it('이동시간을 직접 입력하면 출처가 직접 입력이 되고, 다시 장소 · 수단을 바꿔도 직접 입력이 먼저', async () => {
    const draft = await settingsOf('a1');
    await saveAlarmSettings('a1', { ...draft, travelMinutes: 40 });
    expect(await brief()).toEqual([40, '직접 입력', 60, 'WAKE 오전 8:10', 'PREPARE 오전 8:40', 'DEPARTURE 오전 9:10', 'ARRIVE 오전 9:50']);
    const a = (await getAppointment('a1'))!;
    expect([a.edits.travelMinutes, a.auto.travelMinutes]).toEqual([40, 50]);

    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), transport: 'CAR' }); // 자동값은 35로 바뀌어도 직접 입력 40이 그대로
    const car = (await getAppointment('a1'))!;
    expect([car.travelMinutes, car.travelSource, car.auto.travelMinutes]).toEqual([40, '직접 입력', 35]);

    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), travelMinutes: null }); // 자동으로 되돌림
    const back = (await getAppointment('a1'))!;
    expect([back.travelMinutes, back.travelSource, back.edits.travelMinutes]).toEqual([35, '길찾기', null]);
  });

  it('자동 계산값과 같은 값을 입력하면 직접 입력이 아니라 자동', async () => {
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), travelMinutes: 50, prepareMinutes: 60 });
    const a = (await getAppointment('a1'))!;
    expect([a.edits.travelMinutes, a.edits.prepareMinutes, a.travelSource]).toEqual([null, null, '길찾기 + 내 실측 3회']);
    expect(await listEditLogs()).toEqual([]);
  });

  it('준비 시간을 직접 고르면 기상이 그만큼 움직이고 준비 알람은 기상 뒤 준비 전 활동만큼', async () => {
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), prepareMinutes: 90 });
    expect(await brief()).toEqual([50, '길찾기 + 내 실측 3회', 90, 'WAKE 오전 7:30', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    const a = (await getAppointment('a1'))!;
    expect([a.edits.prepareMinutes, a.auto.predictedPrepMinutes]).toEqual([90, 60]);
  });

  it('알람 시각을 직접 고르면 직접 고름 표시와 함께 자동 계산보다 먼저 — 기상을 옮기면 준비도 같이', async () => {
    const wake = kst(22, 450); // 7:30
    const preview = await previewAlarms('a1', { ...(await settingsOf('a1')), times: { WAKE: wake } });
    expect(preview.alarms.map((x) => `${x.kind} ${formatTime(x.at)}${x.auto ? '*' : ''}`)).toEqual([
      'WAKE 오전 7:30*',
      'PREPARE 오전 8:00', // 직접 고른 기상 뒤 준비 전 활동 30분
      'DEPARTURE 오전 9:00',
      'ARRIVE 오전 9:50',
    ]);

    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), times: { WAKE: wake } });
    expect(await brief()).toEqual([50, '길찾기 + 내 실측 3회', 60, 'WAKE 오전 7:30*', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    const a = (await getAppointment('a1'))!;
    expect(a.edits.times).toEqual({ WAKE: wake });
    expect(a.alarms[0].auto).toEqual(kst(22, 480));
    expect(formatTime((await getNextAlarm())!.alarm.at)).toBe('오전 8:00'); // 지금 7:55 — 직접 고른 기상 7:30은 이미 지나 따라온 준비 8:00이 다음 알람

    // 여유를 바꿔도 직접 고른 기상은 그대로, 자동 계산하는 준비는 기상을 따라가고 출발만 움직임
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), bufferMinutes: 5 });
    expect(await brief()).toEqual([50, '길찾기 + 내 실측 3회', 60, 'WAKE 오전 7:30*', 'PREPARE 오전 8:00', 'DEPARTURE 오전 9:05', 'ARRIVE 오전 9:55']);
  });

  it('직접 고른 시각을 자동으로 되돌림', async () => {
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), times: { WAKE: kst(22, 450), DEPARTURE: kst(22, 535) } });
    expect((await getAppointment('a1'))!.alarms.filter((x) => x.auto).map((x) => x.kind)).toEqual(['WAKE', 'DEPARTURE']);
    await saveAlarmSettings('a1', { ...(await settingsOf('a1')), times: {} });
    expect(await brief()).toEqual([50, '길찾기 + 내 실측 3회', 60, 'WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
  });

  it('순서가 뒤집히면 저장하지 않고 이유를 알림 — 아무것도 바뀌지 않고 기록도 없음', async () => {
    const draft = await settingsOf('a1');
    await expect(saveAlarmSettings('a1', { ...draft, bufferMinutes: 5, times: { PREPARE: kst(22, 470) } })).rejects.toThrow('준비 시각이 기상보다 빠를 수 없어요');
    await expect(saveAlarmSettings('a1', { ...draft, times: { DEPARTURE: kst(22, 600) } })).rejects.toThrow('출발 시각이 도착 목표(오전 9:50)보다 늦을 수 없어요');
    expect((await getAppointment('a1'))!.bufferMinutes).toBe(10);
    expect(await listEditLogs()).toEqual([]);
  });
});

describe('고친 값 기록 (user_edit_logs, 가짜)', () => {
  const edit = (patch: Partial<AlarmSettingsDraft>) => settingsOf('a1').then((draft) => saveAlarmSettings('a1', { ...draft, ...patch }));

  it('H03에서 고친 값마다 한 줄 — 자동값(또는 고치기 전 값) → 고친 값, 화면 · 일정 · 알람 종류 · 시각', async () => {
    await edit({ bufferMinutes: 5, origin: '학교 도서관', transport: 'CAR', travelMinutes: 40, prepareMinutes: 90 });
    const logs = await listEditLogs();
    const at = kst(22, 475); // 시나리오의 지금
    expect(logs).toEqual([
      { at, screen: 'H03', field: 'buffer_minutes', appointmentId: 'a1', autoValue: 10, editedValue: 5 },
      { at, screen: 'H03', field: 'origin', appointmentId: 'a1', autoValue: '집', editedValue: '학교 도서관' },
      { at, screen: 'H03', field: 'transport', appointmentId: 'a1', autoValue: 'TRANSIT', editedValue: 'CAR' },
      { at, screen: 'H03', field: 'travel_minutes', appointmentId: 'a1', autoValue: 20, editedValue: 40 }, // 자동값 = 학교 도서관 · 자차 기준 새로 계산한 값
      { at, screen: 'H03', field: 'prepare_minutes', appointmentId: 'a1', autoValue: 60, editedValue: 90 },
    ]);
  });

  it('알람 시각을 고치면 그 알람 id · 종류와 함께 자동 계산 시각 → 고른 시각, 되돌리면 고른 값이 null', async () => {
    await edit({ times: { WAKE: kst(22, 450) } });
    await edit({ times: {} });
    const logs = await listEditLogs();
    const [picked, reverted] = logs;
    expect(picked).toMatchObject({ screen: 'H03', field: 'scheduled_at', appointmentId: 'a1', alarmId: WAKE, alarmType: 'WAKE' });
    expect([picked.autoValue, picked.editedValue]).toEqual([kst(22, 480), kst(22, 450)]);
    expect([reverted.autoValue, reverted.editedValue]).toEqual([kst(22, 480), null]);
    expect(logs).toHaveLength(2); // 따라온 준비 알람은 사용자가 고른 값이 아니라 기록하지 않음
  });

  it('종류별 켜기 · 강도 — 켜기는 알람마다, 강도 세 칸은 DB 칸 이름(배경음 sound_key · 말소리 voice_tone · 진동 intensity)으로', async () => {
    await edit({ kinds: { WAKE: true, PREPARE: false, DEPARTURE: true }, levels: { sound: 2, voice: 0, vibration: 1 } });
    await edit({ levels: { sound: null, voice: 0, vibration: 1 } });
    const logs = await listEditLogs();
    expect(logs.map((l) => [l.field, l.alarmType ?? '', l.autoValue, l.editedValue])).toEqual([
      ['alarm_enabled', 'PREPARE', true, false],
      ['sound_key', '', 1, 2], // 자동 강도 = 중요도 중요 1점 → 중(1)
      ['voice_tone', '', 1, 0],
      ['intensity', '', 1, 1],
      ['sound_key', '', 1, null],
    ]);
    expect(logs[0]).toMatchObject({ alarmId: 'a1:PREPARE', appointmentId: 'a1' });
  });

  it('고치지 않은 저장은 기록하지 않음', async () => {
    await edit({});
    expect(await listEditLogs()).toEqual([]);
  });

  // 직접 고른 값이 자동값과 같아지면 자동으로 둠 — 이동 수단을 바꿔 자동값이 따라와서 같아진 것은 사용자가 되돌린 것이 아니라 기록하지 않음
  it('이동 수단을 바꿔 새 자동 기상이 직접 고른 기상과 같아져도 되돌린 기록은 없음', async () => {
    await edit({ times: { WAKE: kst(22, 495) } }); // 기상 8:15를 직접 고름 (자동은 8:00)
    db.editLogs.length = 0;
    await edit({ transport: 'CAR' }); // 자동 이동이 35분이 되어 자동 기상도 8:15
    expect((await getAppointment('a1'))!.edits.times).toEqual({});
    expect((await listEditLogs()).map((l) => l.field)).toEqual(['transport']);
  });

  it('이동 수단을 바꿔 새 자동 이동이 직접 입력한 이동과 같아져도 되돌린 기록은 없음', async () => {
    await edit({ travelMinutes: 35 }); // 이동 35분을 직접 고름 (자동은 50분)
    db.editLogs.length = 0;
    await edit({ transport: 'CAR' }); // 자동 이동이 35분
    const a = (await getAppointment('a1'))!;
    expect([a.edits.travelMinutes, a.travelSource]).toEqual([null, '길찾기']);
    expect((await listEditLogs()).map((l) => l.field)).toEqual(['transport']);
  });

  it('돌려주는 목록을 고쳐도 기록은 그대로, 다른 화면(S01)도 같은 기록 함수를 부름', async () => {
    await recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: 'a3', alarmType: 'WAKE', autoValue: 'a', editedValue: 'b' });
    const logs = await listEditLogs();
    logs[0].autoValue = 'x';
    logs.length = 0;
    expect(await listEditLogs()).toEqual([{ at: kst(22, 475), screen: 'S01', field: 'scheduled_at', appointmentId: 'a3', alarmType: 'WAKE', autoValue: 'a', editedValue: 'b' }]);
  });
});

describe('H05 확인 시트에서 알람 시각 고치기 (D43)', () => {
  const draft = (): AppointmentDraft => ({ ...defaultDraft(kst(24, 0), morning), title: '스터디' });

  it('고친 시각으로 저장되고(직접 고름 표시), 고친 값 기록에 H05로 남음', async () => {
    const estimate = await estimateAppointment(draft());
    const auto = estimate.appointment.alarms.find((x) => x.kind === 'WAKE')!.at;
    const wake = new Date(auto.getTime() - 15 * 60_000); // 15분 일찍
    const saved = await createAppointment(adjustEstimate(estimate, 'WAKE', wake));

    const [w, p] = saved.alarms;
    expect([w.kind, w.at, w.auto]).toEqual(['WAKE', wake, auto]);
    expect([p.kind, p.at.getTime(), p.auto]).toEqual(['PREPARE', estimate.appointment.alarms[1].at.getTime() - 15 * 60_000, undefined]); // 준비는 같은 만큼 따라옴
    expect(db.appointments[db.appointments.length - 1].manual).toEqual({ times: { WAKE: wake } });
    expect((await getAppointment(saved.id))!.edits.times).toEqual({ WAKE: wake });

    expect(await listEditLogs()).toEqual([
      { at: kst(22, 475), screen: 'H05', field: 'scheduled_at', appointmentId: saved.id, alarmId: `${saved.id}:WAKE`, alarmType: 'WAKE', autoValue: auto, editedValue: wake },
    ]);
  });

  it('고치지 않았으면 기록 없음, 자동으로 되돌렸으면 직접 고름도 없음', async () => {
    const estimate = await estimateAppointment(draft());
    const wake = estimate.appointment.alarms[0].at;
    const moved = adjustEstimate(estimate, 'WAKE', new Date(wake.getTime() - 600_000));
    const saved = await createAppointment(adjustEstimate(moved, 'WAKE', null));
    expect(saved.alarms.some((x) => x.auto)).toBe(false);
    expect(db.appointments[db.appointments.length - 1].manual).toBeUndefined();
    expect(await listEditLogs()).toEqual([]);
  });

  it('순서가 뒤집히면 저장하지 않음 — 일정도 기록도 안 남음', async () => {
    const estimate = await estimateAppointment(draft());
    const depart = estimate.appointment.alarms.find((x) => x.kind === 'DEPARTURE')!.at;
    const bad = adjustEstimate(estimate, 'PREPARE', new Date(depart.getTime() + 60_000));
    await expect(createAppointment(bad)).rejects.toThrow('출발 시각이 준비보다 빠를 수 없어요');
    expect(db.appointments).toHaveLength(SEEDS.length);
    expect(await listEditLogs()).toEqual([]);
  });
});

describe('H07 · H08 기상 알람 → 해제 → 확인 알림 → 직접 응답', () => {
  it('울림 · 해제 · 확인 중이 내 상태에 보이고, 확인 알림에 직접 응답하면 응답 시각에 확정', async () => {
    const first = await getRing(WAKE);
    expect(formatTime(first!.at)).toBe('오전 8:00');
    await startRing(WAKE, first!.at);
    expect(me()).toBe('알람 울리는 중');

    await dismissRing(WAKE, first!.at);
    expect(me()).toBe('알람 해제 · 기상 확인 중');
    let check = await getWakeCheck(WAKE);
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['observing', '오전 8:00']);

    await promptWake(WAKE, kst(22, 490));
    expect(me()).toBe('알람 해제 · 기상 확인 중');
    check = await getWakeCheck();
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['prompt', '오전 8:00']);

    await confirmWake(WAKE, 'self', kst(22, 492));
    expect(me()).toBe('기상 완료 · 오전 8:12');
    expect(db.wake.phase).toBe('confirmed');
    expect(labels()).toEqual(['오전 8:00 기상 알람 해제', '오전 8:10 확인 알림 발송', '오전 8:12 기상 확인']);
  });

  it('확인 알림에 응답이 없어도 기상 알람을 다시 울리지 않음 (D2 = B) — 확인 알림 단계에 남고, 놓침은 서버 배치가 기록', async () => {
    await startRing(WAKE, kst(22, 480));
    await dismissRing(WAKE, kst(22, 480));
    await promptWake(WAKE, kst(22, 490));
    expect(db.wake.phase).toBe('prompt');
    expect(me()).toBe('알람 해제 · 기상 확인 중');
    expect((await getWakeCheck())!.phase).toBe('prompt');
    expect(labels()).toEqual(['오전 8:00 기상 알람 해제', '오전 8:10 확인 알림 발송']); // 재알람 기록 없음
  });

  it('미루면 울리는 중 표시를 지우고 미루기를 기록 (목업 A.snooze)', async () => {
    await startRing(WAKE, kst(22, 480));
    await snoozeRing(WAKE, 10, kst(22, 480));
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(labels()).toEqual(['오전 8:00 기상 알람 10분 미루기']);
  });

  it('미루기는 3번까지 — 횟수를 getRing이 돌려주고, 한도에 닿으면 4번째는 기록 없이 무시 (D3 기본안 A)', async () => {
    expect(await getRing(WAKE)).toMatchObject({ snoozeCount: 0, snoozeLimit: 3 });
    for (const [index, minutes] of [5, 10, 15].entries()) {
      await startRing(WAKE, kst(22, 480 + index * 10));
      await snoozeRing(WAKE, minutes, kst(22, 480 + index * 10));
      expect((await getRing(WAKE))!.snoozeCount).toBe(index + 1);
    }
    expect(labels()).toEqual(['오전 8:00 기상 알람 5분 미루기', '오전 8:10 기상 알람 10분 미루기', '오전 8:20 기상 알람 15분 미루기']);
    const snoozedUntil = (await getSnooze())!.at;
    await startRing(WAKE, kst(22, 515));
    await snoozeRing(WAKE, 5, kst(22, 515)); // 한도 — 무시
    expect(db.events).toHaveLength(3);
    expect((await getRing(WAKE))!.snoozeCount).toBe(3);
    expect(snoozedUntil.getTime()).toBe(kst(22, 515).getTime()); // 마지막 미루기(8:20 + 15분)가 그대로
  });

  it('해제하면 미룬 횟수는 새로 시작', async () => {
    await snoozeRing(WAKE, 10, kst(22, 480));
    expect((await getRing(WAKE))!.snoozeCount).toBe(1);
    await dismissRing(WAKE, kst(22, 490));
    expect((await getRing(WAKE))!.snoozeCount).toBe(0);
  });

  it('울림에 출발 시각이 실려 "이만큼 미루면 늦어요" 판단에 씀 (서버 꾸러미 departAt과 같은 계산)', async () => {
    const ring = (await getRing(WAKE))!;
    expect(formatTime(ring.departAt!)).toBe('오전 9:00'); // 약속 10:00 − 이동 50분 − 여유 10분
  });

  it('출발 알람이 꺼져 있거나 없으면 departAt은 null — 폰 꾸러미가 출발 알람 행이 있을 때만 departAt을 넣는 것과 같음', async () => {
    db.disabledKinds.add('a1:DEPARTURE');
    expect((await getRing(WAKE))!.departAt).toBeNull();
    db.disabledKinds.delete('a1:DEPARTURE');
    expect((await getRing(WAKE))!.departAt).not.toBeNull();
  });

  it('미루기 · 해제 없이 나가면 울리는 중 표시만 지우고 기록은 없음', async () => {
    await startRing(WAKE, kst(22, 480));
    await stopRing(WAKE);
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(db.wake.phase).toBe('idle');
    expect(db.events).toHaveLength(0);
  });

  it('준비 · 출발 울림의 머리글은 폰 알림과 같은 글자, 기상은 기본 머리글 (이슈 #230)', async () => {
    expect((await getRing('a1:PREPARE'))!.notice).toBe('오전 9:00 출발까지 30분');
    expect((await getRing('a1:DEPARTURE'))!.notice).toBe('지금 나가면 오전 9:50 도착 · 여유 10분');
    expect((await getRing(WAKE))!.notice).toBeUndefined();
  });

  it('출발 알람을 꺼 두면 준비 알림은 출발까지 몇 분인지 모르므로 기본 머리글, 직접 입력한 이동분은 출발 문구에 반영', async () => {
    db.disabledKinds.add('a1:DEPARTURE');
    expect((await getRing('a1:PREPARE'))!.notice).toBeUndefined();
    db.disabledKinds.delete('a1:DEPARTURE');
    db.appointments.find((x) => x.id === 'a1')!.manual = { travelMinutes: 60, times: { DEPARTURE: kst(22, 540) } }; // 출발 알람은 9:00 그대로 + 이동 60분 → 도착 10:00
    expect((await getRing('a1:DEPARTURE'))!.notice).toBe('지금 나가면 오전 10:00 도착 · 여유 없음');
  });

  it('기상 확정한 알람은 다시 울려도 판정 · 기록을 그대로 둠', async () => {
    await startRing(WAKE, kst(22, 480));
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    await startRing(WAKE, kst(22, 495));
    expect(db.wake.phase).toBe('confirmed');
    await dismissRing(WAKE, kst(22, 495));
    await snoozeRing(WAKE, 5, kst(22, 495)); // 확정 뒤에 미뤄도 기록이 붙지 않음
    expect(db.wake.phase).toBe('confirmed');
    expect(me()).toBe('기상 완료 · 오전 8:01');
    expect(labels()).toEqual(['오전 8:00 기상 알람 해제', '오전 8:01 기상 확인']);
  });

  it('준비 · 출발 알람은 해제만 기록하고 기상 판정은 그대로', async () => {
    await startRing('a1:PREPARE', kst(22, 510));
    await dismissRing('a1:PREPARE', kst(22, 510));
    expect(db.wake.phase).toBe('idle');
    expect(labels()).toEqual(['오전 8:30 준비 알람 해제']);
  });
});

describe('H08 기상 확인 화면 데이터', () => {
  it('확정 전인데 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면처럼 null', async () => {
    expect(await getWakeCheck(WAKE)).toBeNull();
    expect(await getWakeCheck()).toBeNull();
    await startRing(WAKE, kst(22, 480));
    expect(await getWakeCheck(WAKE)).toBeNull();
    await stopRing(WAKE);
    expect(await getWakeCheck()).toBeNull();
    await dismissRing(WAKE, kst(22, 480));
    expect((await getWakeCheck())!.phase).toBe('observing');
  });

  it('사용 시간은 db.wake에서 — 해제 0 · 확인 알림 0.4/0 · 직접 응답은 그대로', async () => {
    const use = async () => {
      const c = await getWakeCheck(WAKE);
      return [c!.usage, c!.recent];
    };
    await dismissRing(WAKE, kst(22, 480));
    expect(await use()).toEqual([0, 0]);
    await promptWake(WAKE, kst(22, 490));
    expect(await use()).toEqual([0.4, 0]);
    await confirmWake(WAKE, 'self', kst(22, 491));
    expect(await use()).toEqual([0.4, 0]);
    expect((await getWakeCheck(WAKE))!.confirmed!.how).toBe('self');
  });

  it('자동 판정은 폰을 보며 일어난 값 3.2/1.4', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    const check = await getWakeCheck(WAKE);
    expect([check!.usage, check!.recent, formatTime(check!.confirmed!.at)]).toEqual([3.2, 1.4, '오전 8:01']);
  });

  it('자동 판정 기록 시각 = 누적 사용이 θ(1분)를 넘은 해제 1.5분 뒤 — 확정 · 내 상태 · 기록 모두 같은 시각 (D14)', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490)); // 판정은 관찰이 끝난 8:10
    const wokeAt = kst(22, 481.5);
    expect((await getWakeCheck(WAKE))!.confirmed!.at).toEqual(wokeAt);
    expect(db.me.wakeAt).toEqual(wokeAt);
    expect(db.events.find((e) => e.label === '기상 확인')!.at).toEqual(wokeAt);
    expect(me()).toBe('기상 완료 · 오전 8:01');
  });

  it('직접 응답은 응답한 시각 그대로', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await promptWake(WAKE, kst(22, 490));
    await confirmWake(WAKE, 'self', kst(22, 491));
    expect(db.me.wakeAt).toEqual(kst(22, 491));
    expect(formatTime((await getWakeCheck(WAKE))!.confirmed!.at)).toBe('오전 8:11');
  });

  it('자동 판정이어도 해제 시각을 모르거나 θ를 못 넘으면 넘겨받은 시각', async () => {
    await confirmWake(WAKE, 'auto', kst(22, 490)); // 해제 기록 없음
    expect(db.me.wakeAt).toEqual(kst(22, 490));

    delete db.wakeConfirmations[WAKE];
    const theta = db.wakeThetaMinutes;
    db.wakeThetaMinutes = 4; // 시연 누적 사용 3.2분보다 큼
    try {
      await dismissRing(WAKE, kst(22, 480));
      await confirmWake(WAKE, 'auto', kst(22, 490));
      expect(db.me.wakeAt).toEqual(kst(22, 490));
    } finally {
      db.wakeThetaMinutes = theta;
    }
  });

  it('이미 확정한 알람은 다시 확정해도 처음 판정 그대로', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    await confirmWake(WAKE, 'self', kst(22, 500));
    const check = await getWakeCheck(WAKE);
    expect([check!.confirmed!.how, formatTime(check!.confirmed!.at)]).toEqual(['auto', '오전 8:01']);
    expect(labels()).toEqual(['오전 8:00 기상 알람 해제', '오전 8:01 기상 확인']);
  });

  it('확정한 판정의 사용 시간은 다른 기상 알람이 울려도 그대로', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    db.wake = { ...db.wake, alarmId: 'other:WAKE', phase: 'ringing', usage: 0, recent: 0 }; // 다른 기상 알람이 울림
    const check = await getWakeCheck(WAKE);
    expect([check!.usage, check!.recent, check!.confirmed!.how]).toEqual([3.2, 1.4, 'auto']);
  });
});

describe('반복 묶음 (가짜 데이터: 매주 월 · 수 영어 스터디 4회) — 목록 · 홈은 한 장, 회차 목록은 H03에서만', () => {
  const STUDY = ['st1', 'st2', 'st3', 'st4'];

  it('H02: 묶음당 한 장 — 지금 이후 가장 가까운 회차(5/26)에 남은 회차 수(4)가 붙음, 다른 일정에는 안 붙음', async () => {
    const list = await listAppointments();
    const study = list.filter((a) => a.title === '영어 스터디');
    expect(study.map((a) => [a.id, a.upcomingCount, a.repeatLabel])).toEqual([['st1', 4, '매주 월 · 수']]);
    expect(list.filter((a) => a.id !== 'st1').every((a) => a.upcomingCount === undefined)).toBe(true);
  });

  it('H02: 꺼 둔 회차는 남은 회차 수에서 빠짐 (st2를 끄면 4가 3으로)', async () => {
    db.disabledAppointments.add('st2');
    expect((await listAppointments()).find((a) => a.id === 'st1')?.upcomingCount).toBe(3);
  });

  it('H02 everyOccurrence(H05가 같은 날 앞 일정을 찾을 때)는 묶음을 줄이지 않고 모든 회차', async () => {
    const all = await listAppointments({ everyOccurrence: true });
    expect(all.filter((a) => a.title === '영어 스터디').map((a) => a.id)).toEqual(STUDY);
  });

  it('H03 회차 목록: 같은 묶음의 지금 이후 회차 4개를 시각 순으로 — 어느 회차에서 열어도 같음, 회차마다 첫 알람(기상)', async () => {
    for (const id of ['st1', 'st3']) {
      const occ = await listOccurrences(id);
      expect(occ.map((o) => o.id)).toEqual(STUDY);
      expect(occ.map((o) => formatTime(o.at))).toEqual(['오전 9:00', '오전 9:00', '오전 9:00', '오전 9:00']);
    }
    const occ = await listOccurrences('st1');
    expect(occ.map((o) => o.alarmAt && formatTime(o.alarmAt))).toEqual(['오전 7:25', '오전 7:25', '오전 7:25', '오전 7:25']);
  });

  it('H03 회차 목록: 반복이 아닌 일정 · 없는 일정은 빈 목록, 끈 회차는 첫 알람 없음', async () => {
    expect(await listOccurrences('a2')).toEqual([]);
    expect(await listOccurrences('없는-id')).toEqual([]);
    db.disabledAppointments.add('st2');
    expect((await listOccurrences('st1')).map((o) => o.alarmAt === null)).toEqual([false, true, false, false]);
  });

  it('H01 오늘 일정은 그날 회차만 — 오늘(5/22) · 내일에는 회차가 없고, 5/26에는 그날 회차 하나만', async () => {
    expect((await getDaySchedule(kst(22, 0))).map((x) => x.title)).not.toContain('영어 스터디');
    expect((await getDaySchedule(kst(23, 0))).map((x) => x.title)).not.toContain('영어 스터디');
    expect((await getDaySchedule(kst(26, 0))).map((x) => [x.appointmentId, x.title])).toEqual([['st1', '영어 스터디']]);
    expect((await getDaySchedule(kst(28, 0))).map((x) => x.appointmentId)).toEqual(['st2']);
  });

  it('H01 다음 알람은 가장 가까운 알람 하나만 — 다른 일정을 끄면 스터디 첫 회차(5/26 기상) 하나, 4회가 줄줄이 나오지 않음', async () => {
    for (const id of ['a1', 'a2', 'a3']) db.disabledAppointments.add(id);
    const next = await getNextAlarm();
    expect([next!.appointment.id, next!.alarm.kind, formatTime(next!.alarm.at), next!.alarm.at.getTime() === kst(26, 445).getTime()]).toEqual(['st1', 'WAKE', '오전 7:25', true]);
  });
});
