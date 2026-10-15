import { afterEach, describe, expect, it } from '@jest/globals';

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
  missWake,
  promptWake,
  saveAlarmSettings,
  snoozeRing,
  startRing,
  stopRing,
} from '../api';
import { EVERY_DAY, WEEKDAYS_ONLY } from '../repeat';
import type { AlarmSettingsDraft, AppointmentDraft } from '../types';

const SEED_COUNT = db.appointments.length; // 시드 일정 수 — 테스트가 새로 만든 일정은 매번 지움
const WAKE = 'a1:WAKE'; // 팀 주간회의 기상 오전 8:00
const morning = kst(22, 475); // 오전 7:55
const me = () => memberState('me', morning).text;
const labels = () => db.events.map((e) => `${formatTime(e.at)} ${e.label}`);

afterEach(() => {
  db.appointments.length = SEED_COUNT;
  db.snoozes = {};
  db.disabledKinds.clear();
  db.disabledAppointments.clear();
  db.intensityOverrides = {};
  db.appointments[0].bufferMinutes = 10;
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
    expect((await listAppointments()).map((a) => a.title)).toEqual(['팀 주간회의', '저녁약속', '수업']);
  });

  it('알람 없는 일정은 같은 날 기상 알람으로 세지 않음 — 뒤 일정이 기상 알람을 가짐', async () => {
    await createAppointment(await estimateAppointment(draftWith({ WAKE: false, PREPARE: false, DEPARTURE: false })));
    const later = { ...draftWith({}), time: '16:00' };
    const e = await estimateAppointment(later);
    expect([e.sameDayWake, kindsOf(e.appointment.alarms)[0]]).toEqual([false, 'WAKE']);

    // 앞 일정에 기상 알람이 있으면 지금처럼 외출 준비만
    db.appointments.length = SEED_COUNT;
    await createAppointment(await estimateAppointment(draftWith({})));
    const e2 = await estimateAppointment(later);
    expect([e2.sameDayWake, kindsOf(e2.appointment.alarms)[0]]).toEqual([true, 'PREPARE']);
  });

  it('H03의 "종류를 모두 끔"은 알람을 만들어 둔 채 끈 것 — 알람 목록에 남고 다시 켤 수 있음', async () => {
    const draft = (await getAppointment('a1'))!;
    await saveAlarmSettings('a1', {
      bufferMinutes: draft.bufferMinutes,
      kinds: { WAKE: false, PREPARE: false, DEPARTURE: false },
      levels: { sound: null, voice: null, vibration: null },
    });
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
  const base = async (): Promise<AlarmSettingsDraft> => {
    const a = (await getAppointment('a1'))!;
    return {
      bufferMinutes: a.bufferMinutes,
      kinds: { WAKE: true, PREPARE: true, DEPARTURE: true },
      levels: { sound: null, voice: null, vibration: null },
    };
  };

  it('저장 전에는 아무것도 안 바뀌고, 저장하면 한 번에 반영', async () => {
    const draft = await base();
    const before = (await getAppointment('a1'))!;
    expect(before.intensity.axes.sound.manual).toBe(false);
    const result = await saveAlarmSettings('a1', {
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

describe('H07 · H08 기상 알람 → 해제 → 확인 알림 → 다시 울림', () => {
  it('울림 · 해제 · 확인 중이 내 상태에 보이고, 다시 울린 시각부터 다시 판정', async () => {
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

    await missWake(WAKE, kst(22, 495));
    expect(me()).toBe('알람 울리는 중');
    const again = await getRing(WAKE, true);
    expect(formatTime(again!.at)).toBe('오전 8:15');

    await dismissRing(WAKE, again!.at);
    check = await getWakeCheck(WAKE);
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['observing', '오전 8:15']);

    await confirmWake(WAKE, 'self', kst(22, 505));
    expect(me()).toBe('기상 완료 · 오전 8:25');
    expect(db.wake.phase).toBe('confirmed');
    expect(labels()).toEqual([
      '오전 8:00 기상 알람 해제',
      '오전 8:10 확인 알림 발송',
      '오전 8:15 재알람',
      '오전 8:15 기상 알람 해제',
      '오전 8:25 기상 확인',
    ]);
  });

  it('미루면 울리는 중 표시를 지우고 미루기를 기록 (목업 A.snooze)', async () => {
    await startRing(WAKE, kst(22, 480));
    await snoozeRing(WAKE, 10, kst(22, 480));
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(labels()).toEqual(['오전 8:00 기상 알람 10분 미루기']);
  });

  it('미루기 · 해제 없이 나가면 울리는 중 표시만 지우고 기록은 없음', async () => {
    await startRing(WAKE, kst(22, 480));
    await stopRing(WAKE);
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(db.wake.phase).toBe('idle');
    expect(db.events).toHaveLength(0);
  });

  it('again은 기상 알람만 — 준비 · 출발은 원래 시각과 문장', async () => {
    const prepare = await getRing('a1:PREPARE', true);
    expect(formatTime(prepare!.at)).toBe('오전 8:30');
    expect(prepare!.voiceLine).toBe((await getRing('a1:PREPARE'))!.voiceLine);
    const depart = await getRing('a1:DEPARTURE', true);
    expect(depart!.at).toEqual((await getRing('a1:DEPARTURE'))!.at);
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

  it('주소로 바로 연 다시 울림은 알람 + 관찰 10분 + 응답 없음 5분', async () => {
    const again = await getRing(WAKE, true);
    expect(formatTime(again!.at)).toBe('오전 8:15');
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
