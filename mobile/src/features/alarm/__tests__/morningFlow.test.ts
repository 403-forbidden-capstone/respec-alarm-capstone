import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { now, setScenarioTime } from '@/lib/clock';
import { formatTime } from '@/lib/format';
import { buildServerPackages, type SyncRow } from '@/lib/alarmSync/reconcile';
import { db, kst } from '@/mocks/data';

import { checkDepartNow, confirmWake, dismissRing, getMorningPlan, getRing, startRing } from '../api';
import { morningCardView, morningCardVisible, upcomingNotices } from '../morning';

// 하루 재생 (이슈 #230 PR 1b) — 서버 supabase/functions/_shared/morning-flow.test.ts와 같은 하루(10시 수업 · 이동 50분 · 여유 10분: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50)를
// 앱 쪽에서 이어서 확인: 폰 알림 글자(H07 미리 보기와 같은 글자) → 기상 해제 → 기상 확정(H08) → 오늘 첫 일정 한 줄 → 홈 아침 카드 → 지금 나가면 → 출발 → 카드 숨김
//   지금 시각은 단계마다 정함. 가짜 데이터의 일정은 a1 "팀 주간회의"(오전 10:00 세종대학교)
let mockNow: Date | null = null;
jest.mock('@/lib/clock', () => {
  const actual = jest.requireActual<typeof import('@/lib/clock')>('@/lib/clock');
  return { ...actual, now: () => mockNow ?? actual.now() };
});

const SEEDS = db.appointments.map((a) => ({ ...a }));
const WAKE = 'a1:WAKE';
const at = (hhmm: string, day = 22) => {
  const [h, m] = hhmm.split(':').map(Number);
  return kst(day, h * 60 + m);
};
const clock = (hhmm: string, day = 22) => {
  mockNow = at(hhmm, day);
};

afterEach(() => {
  mockNow = null;
  setScenarioTime('morning');
  db.appointments.splice(0, db.appointments.length, ...SEEDS.map((a) => ({ ...a })));
  db.disabledKinds.clear();
  db.disabledAppointments.clear();
  db.wake = { alarmId: null, phase: 'idle', ringAt: null, dismissedAt: null, usage: 0, recent: 0 };
  db.events.length = 0;
  db.me.wakeAt = null;
  db.me.departAt = null;
  for (const id of Object.keys(db.wakeConfirmations)) delete db.wakeConfirmations[id];
});

// 사용자 앞에 보이는 카드 글자 (null이면 카드가 안 보임)
async function homeCard(hhmm: string) {
  clock(hhmm);
  const plan = await getMorningPlan();
  if (!plan || !morningCardVisible(plan, mockNow!)) return null;
  return morningCardView(plan, null, mockNow!);
}

describe('getMorningPlan (가짜 데이터)', () => {
  it('오늘 첫 일정: 켜진 기상 알람이 붙은 가장 이른 약속의 칸 — 기상 확인 전', async () => {
    const plan = await getMorningPlan();
    expect(plan).toMatchObject({
      appointmentId: 'a1',
      title: '팀 주간회의',
      place: '세종대학교',
      wakeAlarmId: WAKE,
      travelMinutes: 50,
      travelSource: '길찾기 + 내 실측 3회',
      wakeConfirmedAt: null,
      departedAt: null,
    });
    expect([plan?.at, plan?.prepareAt, plan?.departAt, plan?.arriveAt].map((d) => formatTime(d!))).toEqual(['오전 10:00', '오전 8:30', '오전 9:00', '오전 9:50']);
  });

  it('꺼 둔 알람의 시각은 빈 값 (준비 · 출발), 직접 입력한 이동분은 반영', async () => {
    db.disabledKinds.add('a1:PREPARE');
    db.disabledKinds.add('a1:DEPARTURE');
    db.appointments.find((a) => a.id === 'a1')!.manual = { travelMinutes: 65 };
    const plan = await getMorningPlan();
    expect([plan?.prepareAt, plan?.departAt]).toEqual([null, null]);
    expect([plan?.travelMinutes, plan?.travelSource]).toEqual([65, '직접 입력']);
  });

  it('기상 알람이 꺼져 있거나 일정 전체를 끄면, 그날 일정이 없으면 null', async () => {
    db.disabledKinds.add('a1:WAKE');
    expect(await getMorningPlan()).toBeNull();
    db.disabledKinds.clear();
    db.disabledAppointments.add('a1');
    expect(await getMorningPlan()).toBeNull();
    db.disabledAppointments.clear();
    db.appointments.splice(0, db.appointments.length, ...SEEDS.filter((a) => a.id === 'a3').map((a) => ({ ...a }))); // 오늘(22일)은 일정 없음, 수업은 23일
    expect(await getMorningPlan()).toBeNull();
  });

  it('기상 알람이 없는 일정(저녁약속 · 알람 없는 치과)만 남으면 첫 일정이 없음', async () => {
    clock('7:55');
    expect((await getMorningPlan())?.appointmentId).toBe('a1');
    db.appointments.splice(0, 1); // 팀 주간회의를 지움 → 저녁약속(기상 없음) · 치과(알람 없음)만 남아 기상 알람이 붙은 약속이 없음
    expect(await getMorningPlan()).toBeNull();
  });

  it('저녁(18시~)에는 홈처럼 내일 일정 — 전날 밤 9시에는 22일 일정', async () => {
    setScenarioTime('evening'); // 5월 21일 밤 9시
    const plan = await getMorningPlan();
    expect(plan?.appointmentId).toBe('a1');
    expect(morningCardVisible(plan, now())).toBe(false); // 저녁이라 카드는 안 보임
  });
});

describe('checkDepartNow (가짜 데이터)', () => {
  it('일정에 적힌 이동분으로: 지금 + 이동 = 도착, 여유 · 상태는 departNow', async () => {
    clock('8:30');
    const check = await checkDepartNow('a1');
    expect([formatTime(check.arriveAt), check.travelMinutes, check.source, check.slackMinutes, check.status, formatTime(check.checkedAt)]).toEqual([
      '오전 9:20',
      50,
      '길찾기 + 내 실측 3회',
      40,
      'COMFORT',
      '오전 8:30',
    ]);
    clock('9:20');
    expect(await checkDepartNow('a1')).toMatchObject({ slackMinutes: -10, status: 'LATE_RISK' });
  });

  it('직접 입력한 이동분이 있으면 그 값 · 출처 "직접 입력", 없는 일정은 UserError', async () => {
    clock('8:30');
    db.appointments.find((a) => a.id === 'a1')!.manual = { travelMinutes: 70 };
    expect(await checkDepartNow('a1')).toMatchObject({ travelMinutes: 70, source: '직접 입력', slackMinutes: 20 });
    await expect(checkDepartNow('없는 일정')).rejects.toMatchObject({ name: 'UserError' });
  });
});

describe('하루 재생: 폰 알림 → 기상 해제 → 기상 확정(H08) → 오늘 첫 일정 → 홈 아침 카드 → 지금 나가면 → 출발', () => {
  it('폰이 띄우는 알림 글자와 H07 미리 보기 머리글이 같음 (서버 하루 재생과 같은 글자)', async () => {
    const lesson = { title: '팀 주간회의', appointment_at: kst(22, 600).toISOString(), dest_name: '세종대학교' };
    const row = (alarm_id: string, alarm_type: SyncRow['alarm_type'], at: Date): SyncRow => ({
      alarm_id,
      alarm_type,
      scheduled_at: at.toISOString(),
      intensity: 'NORMAL',
      sound_key: null,
      snooze_limit: 3,
      is_enabled: true,
      participant_id: 'p1',
      routine_id: null,
      appointment: lesson,
      travel_minutes: 50,
      routine_title: null,
    });
    const packages = Object.fromEntries(
      buildServerPackages([row('wake', 'WAKE', at('8:00')), row('prep', 'PREPARE', at('8:30')), row('dep', 'DEPARTURE', at('9:00')), row('arr', 'ARRIVE', at('9:50'))]).map((p) => [p.alarmId, p]),
    );
    expect(packages.prep.notice).toBe('오전 9:00 출발까지 30분');
    expect(packages.dep.notice).toBe('지금 나가면 오전 9:50 도착 · 여유 10분');
    expect((await getRing('a1:PREPARE'))!.notice).toBe(packages.prep.notice);
    expect((await getRing('a1:DEPARTURE'))!.notice).toBe(packages.dep.notice);
  });

  it('정시 기상: 알람 시각부터 카드(확정을 기다리지 않음) → 다시 확인 → 출발하면 사라짐', async () => {
    // 알람 전에는 카드 없음
    expect(await homeCard('7:55')).toBeNull();
    // 8:00 알람 울림 → 해제. 기상 확정 전이어도 홈 인사 아래에 카드 (원탭 확인 줄이기, #240)
    clock('8:00');
    await startRing(WAKE, at('8:00'));
    await dismissRing(WAKE, at('8:00'));
    expect(await homeCard('8:05')).not.toBeNull();

    // 폰을 보며 일어남 → 해제 1.5분 뒤 확정 (D14). 카드 글자는 확정과 상관없이 같음
    await confirmWake(WAKE, 'auto', at('8:10'));
    const plan = (await getMorningPlan())!;
    expect(formatTime(plan.wakeConfirmedAt!)).toBe('오전 8:01');
    expect(upcomingNotices(plan, at('8:05')).map((x) => `${x.label} ${formatTime(x.at)}`)).toEqual(['준비 오전 8:30', '출발 오전 9:00']); // H08 "다음 알림"
    expect(await homeCard('8:05')).toEqual({
      summary: '오전 10:00 팀 주간회의 · 세종대학교',
      untilDepart: '출발까지 55분',
      nowLine: '지금 나가면 오전 8:55 도착 · 여유 1시간 5분',
      status: 'COMFORT',
      statusLabel: '여유',
      travelLine: '이동 50분 · 길찾기 + 내 실측 3회',
    });

    // [다시 확인] — 9:00 출발 시각 직전
    clock('8:59');
    const check = await checkDepartNow('a1');
    expect(morningCardView(plan, check, mockNow!)).toMatchObject({ nowLine: '지금 나가면 오전 9:49 도착 · 여유 11분', status: 'COMFORT', travelLine: '이동 50분 · 길찾기 + 내 실측 3회 · 오전 8:59 확인' });

    // 출발 기록(원탭 · 위치)이 들어오면 카드는 사라짐
    db.me.departAt = at('9:02');
    expect((await getMorningPlan())!.departedAt).toEqual(at('9:02'));
    expect(await homeCard('9:03')).toBeNull();
  });

  it('정시에 출발하면 도착 9:50 · 여유 10분 — 출발 알림 글자와 같은 값', async () => {
    await dismissRing(WAKE, at('8:05'));
    await confirmWake(WAKE, 'self', at('8:05'));
    clock('9:00');
    const plan = (await getMorningPlan())!;
    expect(morningCardView(plan, null, mockNow!)).toMatchObject({ nowLine: '지금 나가면 오전 9:50 도착 · 여유 10분', status: 'COMFORT', untilDepart: '지금 출발할 시간이에요' });
  });

  it('늦게 일어난 날(9:20 기상): 출발 시각이 지났어도 출발 + 30분까지 지각 위험으로 보이고, 그 뒤에는 사라짐', async () => {
    await dismissRing(WAKE, at('9:20'));
    await confirmWake(WAKE, 'self', at('9:20'));
    expect(await homeCard('9:20')).toMatchObject({ nowLine: '지금 나가면 오전 10:10 도착 · 10분 늦어요', status: 'LATE_RISK', statusLabel: '지각 위험', untilDepart: '출발 시각이 지났어요' }); // 서버 표: 바로 나가도 10분 늦음
    expect(await homeCard('9:30')).not.toBeNull();
    expect(await homeCard('9:31')).toBeNull();
  });

  it('전날 밤(저녁 화면)에는 이미 기상을 확정한 일정이 있어도 카드는 없음', async () => {
    await dismissRing(WAKE, at('8:00'));
    await confirmWake(WAKE, 'auto', at('8:10'));
    setScenarioTime('evening'); // 5월 21일 밤 9시 — 홈은 내일(22일) 화면
    const plan = (await getMorningPlan())!;
    expect(plan.wakeConfirmedAt).not.toBeNull(); // 확정 · 출발 전 · 출발 + 30분 안인데도 저녁이라 숨김
    expect(morningCardVisible(plan, now())).toBe(false);
  });
});
