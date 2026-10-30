import { describe, expect, it } from '@jest/globals';

import { IMPORTANCE_POINT, KIND_LABEL, toAlarmIntensity } from '@/features/alarm/types';
import { buildRingPackages, canceledAlarmIds, subtitleFor } from '@shared/ring-package.ts';
import { IMPORTANCE_POINT as SHARED_IMPORTANCE_POINT, LEVEL_FIELDS } from '@shared/calc/intensity.ts';
import { KIND_LABEL as SHARED_KIND_LABEL } from '@shared/calc/types.ts';
import { departNow, departSlack } from '@shared/calc/depart.ts';
import { parseRecurrence, parseRepeatDays as parseServerRepeatDays } from '@shared/calc/recur.ts';
import { formatKoDuration } from '@shared/tz.ts';
import { repeatToRrule, rruleToRepeat } from '@/features/alarm/repeat';
import { parseRepeatDays as parseRoutineRepeatDays } from '@/features/routine/map';
import { formatDuration } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

// 서버 함수와 같이 쓰는 공용 계산(supabase/functions/_shared) 경로 별칭이 앱 · jest에서 풀리는지,
// 앱에도 따로 적어 둔 값(중요도 점수 · 종류 이름 · 강도 이름)이 공용 값과 어긋나지 않는지 (한쪽만 고치면 여기서 잡힘)
describe('공용 계산 경로 별칭 (@shared)', () => {
  it('예약 꾸러미 조립을 서버와 같은 파일로 부름', () => {
    const packages = buildRingPackages({
      alarms: [
        { alarm_id: 'b', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-20T00:00:00.000Z', intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: true },
        { alarm_id: 'a', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', intensity: 'STRONG', sound_key: 'theme_urgent', snooze_limit: 3, is_enabled: true },
        { alarm_id: 'c', alarm_type: 'PREPARE', scheduled_at: '2026-10-19T23:00:00.000Z', intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: false },
      ],
      title: '팀 주간회의',
      subtitle: subtitleFor(new Date('2026-10-20T01:00:00.000Z'), '세종대학교', 'Asia/Seoul'),
    });
    expect(packages.map((p) => p.alarmId)).toEqual(['a', 'b']); // 꺼진 알람 제외 · 시각순
    expect(packages[0]).toMatchObject({ type: 'WAKE', atMillis: Date.parse('2026-10-19T22:30:00.000Z'), title: '팀 주간회의', subtitle: '오전 10:00 · 세종대학교', intensity: 'STRONG', soundKey: 'theme_urgent' });
    expect(canceledAlarmIds({ before: [{ alarm_id: 'a' }, { alarm_id: 'c' }], after: [{ alarm_id: 'a', is_enabled: true }] })).toEqual(['c']);
  });

  it('출발 여유 계산(7장 7.5.2)을 서버와 같은 파일로 부름', () => {
    const appointmentAt = new Date('2025-05-22T01:00:00.000Z'); // 한국 시각 10:00
    const base = { appointmentAt, travelMinutes: 50 };
    const wake = (utcHour: number, minute: number) => departSlack({ ...base, now: new Date(Date.UTC(2025, 4, 21, utcHour, minute)), remainingMinutes: 60 });
    expect([wake(23, 0), wake(23, 5), wake(23, 25)]).toEqual([
      { slackMinutes: 10, status: 'COMFORT' }, // 8:00 기상
      { slackMinutes: 5, status: 'TIGHT' }, // 8:05
      { slackMinutes: -15, status: 'LATE_RISK' }, // 8:25
    ]);
    const leave = departNow({ ...base, now: new Date('2025-05-22T00:00:00.000Z') }); // 9:00 출발
    expect([leave.arriveAt.toISOString(), leave.slackMinutes, leave.status]).toEqual(['2025-05-22T00:50:00.000Z', 10, 'COMFORT']);
  });

  it('앱의 시간 길이 글자(lib/format formatDuration)가 서버 알림 문구의 formatKoDuration과 같음', () => {
    for (const minutes of [0, 1, 30, 59, 60, 61, 70, 90, 125, 600, 0.4, 29.6, -5]) {
      expect(formatDuration(minutes)).toBe(formatKoDuration(minutes));
    }
    expect(formatDuration(70)).toBe('1시간 10분');
  });

  it('앱에 적어 둔 값이 공용 값과 같음', () => {
    expect(IMPORTANCE_POINT).toEqual(SHARED_IMPORTANCE_POINT);
    expect(KIND_LABEL).toEqual(SHARED_KIND_LABEL);
    expect(([0, 1, 2] as const).map(toAlarmIntensity)).toEqual(LEVEL_FIELDS.map((f) => f.intensity));
  });
});

// 반복 규칙 해석이 서버(공용 recur.ts — alarm-roll이 회차를 만드는 데 씀)와 앱(화면 표시 · 저장)에서 같은 요일 집합을 주는지
// 서버가 회차를 만드는 요일과 앱이 "매주 월 · 수"로 보여 주는 요일이 어긋나면 안 됨 — 한쪽만 고치면 여기서 잡힘
describe('반복 규칙 해석 (서버 calc/recur.ts ↔ 앱)', () => {
  // 요일 번호: 월 0 … 일 6 (앱 WEEKDAYS 순서 = 서버 WEEKDAY_CODES 순서)
  const appDays = (days: readonly Weekday[]) => days.map((d) => WEEKDAYS.indexOf(d));
  const serverDays = (rule: string | null | undefined): number[] => {
    const rec = parseRecurrence(rule);
    if (!rec) return []; // 서버가 "반복 아님"으로 보는 것 (null)과 앱의 "요일 없음"([])은 같은 뜻
    return rec.freq === 'DAILY' ? [0, 1, 2, 3, 4, 5, 6] : [...rec.days];
  };

  // 일정 반복 규칙(appointments.recurrence_rule) — 앱이 만드는 모양 두 가지와 읽을 때 너그럽게 받는 변형
  const RULES: [rule: string | null | undefined, days: number[]][] = [
    ['FREQ=DAILY', [0, 1, 2, 3, 4, 5, 6]],
    ['FREQ=WEEKLY;BYDAY=MO', [0]],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR', [0, 2, 4]],
    ['FREQ=WEEKLY;BYDAY=SA,SU', [5, 6]],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', [0, 1, 2, 3, 4, 5, 6]],
    ['FREQ=WEEKLY;BYDAY=FR,MO', [0, 4]], // 순서가 달라도 월요일부터
    ['FREQ=WEEKLY;BYDAY=MO,MO,WE', [0, 2]], // 겹친 요일은 하나로
    ['RRULE:FREQ=WEEKLY;BYDAY=TU', [1]], // RRULE: 접두사
    ['freq=weekly;byday=th', [3]], // 소문자
    ['BYDAY=MO;FREQ=WEEKLY', [0]], // 칸 순서
    ['FREQ=WEEKLY', []], // 요일 없는 주간 규칙 = 반복 없음
    ['FREQ=MONTHLY', []], // 앱은 모르는 FREQ를 반복 없음으로, 서버는 거절 — 둘 다 요일 없음
    ['', []],
    [null, []],
    [undefined, []],
  ];

  it.each(RULES)('일정 반복 %s → 서버와 앱이 같은 요일 집합', (rule, days) => {
    expect(serverDays(rule)).toEqual(days);
    expect(appDays(rruleToRepeat(rule))).toEqual(days);
  });

  // 표에서 뺀 의도된 차이: 서버는 두 모양(DAILY · WEEKLY;BYDAY) 밖이면 통째로 거절하고, 앱은 읽을 수 있는 만큼 읽어 건너뜀 (서버가 회차를 안 만들면 앱 표시만 남음)
  //   · FREQ=WEEKLY;INTERVAL=2;BYDAY=MO — 앱은 INTERVAL을 무시해 [월], 서버는 거절
  //   · FREQ=DAILY;INTERVAL=2 — 앱은 매일, 서버는 거절
  //   · FREQ=WEEKLY;BYDAY=MO,XX — 앱은 모르는 요일 코드를 건너뛰어 [월], 서버는 거절
  //   앱이 만드는 규칙(repeatToRrule)은 두 모양뿐이라 실제로는 만나지 않음 (대화 · 시간표 캡처가 넣는 규칙은 서버 draft.ts가 두 모양만 받음)
  it('서버가 거절하고 앱이 건너뛰어 읽는 모양은 서버가 반복 아님으로 봄 (의도된 차이)', () => {
    for (const rule of ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'FREQ=DAILY;INTERVAL=2', 'FREQ=WEEKLY;BYDAY=MO,XX']) {
      expect(parseRecurrence(rule)).toBeNull();
      expect(rruleToRepeat(rule).length).toBeGreaterThan(0);
    }
  });

  it('앱이 만드는 규칙(repeatToRrule)은 서버가 같은 요일로 읽음', () => {
    for (const days of [['월'], ['화', '목'], ['월', '수', '금'], ['토', '일'], [...WEEKDAYS]] as Weekday[][]) {
      expect(serverDays(repeatToRrule(days))).toEqual(appDays(days));
    }
  });

  // 루틴 반복 요일(routines.repeat_days) — 'MON,WED' · 'MON~FRI' · 'SAT~MON'(일요일을 넘는 범위)
  const ROUTINE_TEXT: [text: string | null | undefined, days: number[]][] = [
    ['MON,WED,FRI', [0, 2, 4]],
    ['MON~FRI', [0, 1, 2, 3, 4]],
    ['SAT~MON', [0, 5, 6]], // 일요일을 넘는 범위
    ['FRI~TUE', [0, 1, 4, 5, 6]],
    ['MON-WED', [0, 1, 2]], // ~ 대신 -
    ['MON WED', [0, 2]], // 공백 구분
    ['mon,wed', [0, 2]], // 소문자
    ['MON~FRI,SUN', [0, 1, 2, 3, 4, 6]], // 범위 + 낱개
    ['SUN', [6]],
    ['MON,XYZ', [0]], // 모르는 글자는 건너뜀
    ['XYZ~MON', []],
    ['', []],
    [null, []],
    [undefined, []],
  ];

  it.each(ROUTINE_TEXT)('루틴 반복 %s → 서버와 앱이 같은 요일 집합', (text, days) => {
    expect(parseServerRepeatDays(text)).toEqual(days);
    expect(appDays(parseRoutineRepeatDays(text))).toEqual(days);
  });
});
