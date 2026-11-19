import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';
import { departureNotice } from '@shared/ring-package.ts';

import {
  departNowLine,
  departReference,
  MORNING_CARD_GRACE_MINUTES,
  morningCardView,
  morningCardVisible,
  morningDay,
  morningDayWord,
  pickMorningSource,
  toDepartCheck,
  toMorningPlan,
  upcomingNotices,
  wakeAlarmOf,
  type MorningSource,
  tripCardOf,
} from '../morning';
import type { AlarmKind, AlarmTime, MorningPlan } from '../types';

// 5월 22일 한국 시각 — 팀 주간회의 10:00 (기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50, 이동 50분)
const at = (hhmm: string, day = 22) => {
  const [h, m] = hhmm.split(':').map(Number);
  return kst(day, h * 60 + m);
};
const alarm = (kind: AlarmKind, hhmm: string, enabled = true): AlarmTime => ({ id: `a1:${kind}`, kind, at: at(hhmm), enabled });
const chain = (): AlarmTime[] => [alarm('WAKE', '8:00'), alarm('PREPARE', '8:30'), alarm('DEPARTURE', '9:00'), alarm('ARRIVE', '9:50')];

const source = (overrides: Partial<MorningSource> = {}): MorningSource => ({
  appointmentId: 'a1',
  title: '팀 주간회의',
  at: at('10:00'),
  place: '세종대학교',
  travelMinutes: 50,
  travelSource: '길찾기',
  alarms: chain(),
  departedAt: null,
  arrivedAt: null,
  ...overrides,
});

const plan = (overrides: Partial<MorningPlan> = {}): MorningPlan => ({ ...toMorningPlan(source(), at('8:03'))!, ...overrides });

describe('오늘 첫 일정 고르기', () => {
  it('낮에는 오늘, 저녁(18시~)에는 내일 — 홈과 같음', () => {
    expect(morningDay(at('7:55'))).toEqual(at('0:00'));
    expect(morningDay(at('17:59'))).toEqual(at('0:00'));
    expect(morningDay(at('18:00'))).toEqual(at('0:00', 23));
    expect(morningDay(at('23:30'))).toEqual(at('0:00', 23)); // 새벽 약속의 기상 알람은 전날 밤에 울림
    expect([morningDayWord(at('7:55')), morningDayWord(at('21:00'))]).toEqual(['오늘', '내일']);
  });

  it('켜진 기상 알람이 붙은 약속 중 가장 이른 것 — 목록 순서와 상관없이', () => {
    const lunch = source({ appointmentId: 'a2', title: '점심', at: at('12:00'), alarms: [alarm('WAKE', '9:00')] });
    const noWake = source({ appointmentId: 'a3', title: '치과', at: at('9:00'), alarms: [alarm('PREPARE', '8:00')] });
    expect(pickMorningSource([lunch, noWake, source()])?.appointmentId).toBe('a1');
    expect(pickMorningSource([lunch, noWake])?.appointmentId).toBe('a2');
  });

  it('꺼 둔 기상은 세지 않음 — 이 약속은 첫 일정이 아님', () => {
    const off = source({ alarms: [alarm('WAKE', '8:00', false), alarm('PREPARE', '8:30')] });
    const later = source({ appointmentId: 'a2', at: at('14:00'), alarms: [alarm('WAKE', '11:00')] });
    expect(pickMorningSource([off, later])?.appointmentId).toBe('a2');
    expect(pickMorningSource([off])).toBeNull();
    expect(pickMorningSource([])).toBeNull();
  });

  it('약속 시각이 같으면 둘 다 기상을 가진 것으로 보고 먼저 온 것 (서버 hasEarlierWake와 같은 기준)', () => {
    const first = source({ appointmentId: 'x1' });
    const second = source({ appointmentId: 'x2' });
    expect(pickMorningSource([first, second])?.appointmentId).toBe('x1');
    expect(pickMorningSource([second, first])?.appointmentId).toBe('x2');
  });

  it('칸: 준비 · 출발 · 도착 목표는 켜진 알람의 시각, 꺼졌거나 없으면 null', () => {
    const p = toMorningPlan(source({ alarms: [alarm('WAKE', '8:00'), alarm('PREPARE', '8:30', false), alarm('DEPARTURE', '9:00')] }), null)!;
    expect(p).toMatchObject({ appointmentId: 'a1', wakeAlarmId: 'a1:WAKE', wakeAt: at('8:00'), title: '팀 주간회의', place: '세종대학교', travelMinutes: 50, travelSource: '길찾기', wakeConfirmedAt: null, departedAt: null });
    expect([p.prepareAt, p.departAt, p.arriveAt]).toEqual([null, at('9:00'), null]);
    expect(wakeAlarmOf(source({ alarms: [alarm('PREPARE', '8:30')] }))).toBeUndefined();
    expect(toMorningPlan(source({ alarms: [alarm('PREPARE', '8:30')] }), null)).toBeNull();
  });
});

describe('홈 아침 카드가 보이는 때', () => {
  const seen = (p: MorningPlan | null, hhmm: string) => morningCardVisible(p, at(hhmm));

  it('기상 알람 시각부터 보임 — 기상 확정을 기다리지 않음 (원탭 확인 줄이기, #240)', () => {
    expect(seen(plan({ wakeConfirmedAt: null }), '7:59')).toBe(false);
    expect(seen(plan({ wakeConfirmedAt: null }), '8:00')).toBe(true);
    expect(seen(plan({ wakeConfirmedAt: null }), '8:05')).toBe(true);
    expect(seen(plan(), '8:05')).toBe(true);
  });

  it('알람 시각 전이라도 확정 기록이 있으면(가짜 모드의 시나리오 시계) 보임', () => {
    expect(seen(plan({ wakeConfirmedAt: at('8:30') }), '7:55')).toBe(true);
  });

  it('출발 시각 + 30분까지 보이고 그 뒤에는 숨김', () => {
    expect(MORNING_CARD_GRACE_MINUTES).toBe(30);
    expect(seen(plan(), '9:30')).toBe(true); // 정확히 출발 + 30분
    expect(seen(plan(), '9:31')).toBe(false);
  });

  it('출발 기록이 있으면 숨김', () => {
    expect(seen(plan({ departedAt: at('8:50') }), '8:55')).toBe(false);
  });

  it('저녁(18시~)이면 숨김 — 새벽 약속의 기상 확인이 전날 밤에 되어도 홈은 내일 화면', () => {
    const late = plan({ at: at('1:00', 23), departAt: at('0:20', 23), wakeConfirmedAt: at('23:25') });
    expect(seen(late, '23:30')).toBe(false);
    expect(seen(plan({ departAt: at('19:00') }), '18:00')).toBe(false);
  });

  it('출발 알람이 없으면 약속 − 이동을 출발 한계로 봄', () => {
    const p = plan({ departAt: null }); // 10:00 − 50분 = 9:10
    expect(departReference(p)).toEqual(at('9:10'));
    expect(seen(p, '9:40')).toBe(true);
    expect(seen(p, '9:41')).toBe(false);
  });

  it('일정이 없으면 숨김', () => {
    expect(seen(null, '8:05')).toBe(false);
  });
});

describe('다음 알림', () => {
  it('아직 안 울린 준비 · 출발만, 시각 순', () => {
    expect(upcomingNotices(plan(), at('8:05')).map((x) => `${x.label} ${formatTime(x.at)}`)).toEqual(['준비 오전 8:30', '출발 오전 9:00']);
    expect(upcomingNotices(plan(), at('8:40')).map((x) => x.label)).toEqual(['출발']);
    expect(upcomingNotices(plan(), at('9:00'))).toEqual([]); // 울리는 시각이 된 것은 다음이 아님
    expect(upcomingNotices(plan({ prepareAt: null, departAt: null }), at('8:05'))).toEqual([]);
  });
});

describe('지금 나가면', () => {
  it('도착 = 지금 + 이동, 여유 = 약속 − 도착 (서버 departNow와 같음)', () => {
    const check = toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 50, source: '길찾기', now: at('8:30') });
    expect([formatTime(check.arriveAt), check.slackMinutes, check.status, check.travelMinutes, check.source, formatTime(check.checkedAt)]).toEqual(['오전 9:20', 40, 'COMFORT', 50, '길찾기', '오전 8:30']);
    expect(toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 50, source: '', now: at('9:05') })).toMatchObject({ slackMinutes: 5, status: 'TIGHT' });
    expect(toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 50, source: '', now: at('9:10') })).toMatchObject({ slackMinutes: 0, status: 'TIGHT' }); // 딱 맞으면 빠듯
    expect(toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 50, source: '', now: at('9:11') })).toMatchObject({ slackMinutes: -1, status: 'LATE_RISK' });
  });

  it('카드 글자는 서버 출발 알림 글자(departureNotice)와 같음 — 여유 · 여유 없음 · 늦어요 · 1시간 넘는 여유', () => {
    for (const hhmm of ['8:30', '9:10', '9:25', '7:00']) {
      const check = toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 50, source: '', now: at(hhmm) });
      const server = departureNotice({ departAt: at(hhmm), appointmentAt: at('10:00'), travelMinutes: 50, timeZone: 'Asia/Seoul' });
      expect(departNowLine(check.arriveAt, check.slackMinutes)).toBe(server);
    }
    expect(departNowLine(at('9:20'), 40)).toBe('지금 나가면 오전 9:20 도착 · 여유 40분');
    expect(departNowLine(at('10:00'), 0)).toBe('지금 나가면 오전 10:00 도착 · 여유 없음');
    expect(departNowLine(at('10:17'), -17)).toBe('지금 나가면 오전 10:17 도착 · 17분 늦어요');
    expect(departNowLine(at('8:45'), 75)).toBe('지금 나가면 오전 8:45 도착 · 여유 1시간 15분');
  });
});

describe('카드에 그릴 글자', () => {
  // 이슈 #230 완료 기준의 보기: 출발까지 1시간 10분 · 지금 나가면 9:47 도착(여유 13분)
  const example = plan({ departAt: at('9:40'), travelMinutes: 77 });

  it('이슈 보기 그대로: 출발까지 1시간 10분 · 지금 나가면 오전 9:47 도착 · 여유 13분 · 여유', () => {
    const view = morningCardView(example, null, at('8:30'));
    expect(view).toEqual({
      summary: '오전 10:00 팀 주간회의 · 세종대학교',
      untilDepart: '출발까지 1시간 10분',
      nowLine: '지금 나가면 오전 9:47 도착 · 여유 13분',
      status: 'COMFORT',
      statusLabel: '여유',
      travelLine: '이동 77분 · 길찾기',
    });
  });

  it('마지막으로 다시 확인한 이동분이 있으면 그 값으로 셈하고 확인 시각을 붙임, 도착 · 여유는 지금 기준', () => {
    const check = toDepartCheck({ appointmentAt: at('10:00'), travelMinutes: 60, source: '길찾기', now: at('8:31') });
    const view = morningCardView(example, check, at('8:40'));
    expect(view).toMatchObject({ nowLine: '지금 나가면 오전 9:40 도착 · 여유 20분', travelLine: '이동 60분 · 길찾기 · 오전 8:31 확인', untilDepart: '출발까지 1시간' });
  });

  it('빠듯 · 지각 위험은 글자로 구분하고 출발이 지나면 안내 문구', () => {
    expect(morningCardView(example, null, at('8:40'))).toMatchObject({ status: 'TIGHT', statusLabel: '빠듯', nowLine: '지금 나가면 오전 9:57 도착 · 여유 3분' });
    expect(morningCardView(example, null, at('8:46'))).toMatchObject({ status: 'LATE_RISK', statusLabel: '지각 위험', nowLine: '지금 나가면 오전 10:03 도착 · 3분 늦어요' });
    expect(morningCardView(example, null, at('9:40')).untilDepart).toBe('지금 출발할 시간이에요');
    expect(morningCardView(example, null, at('9:50')).untilDepart).toBe('출발 시각이 지났어요');
  });

  it('출발 알람이 없으면 출발까지 줄이 없음, 장소가 없으면 시각 · 제목만, 이동 출처가 비면 이동분만', () => {
    const view = morningCardView(plan({ departAt: null, place: '', travelSource: '' }), null, at('8:30'));
    expect(view).toMatchObject({ untilDepart: null, summary: '오전 10:00 팀 주간회의', travelLine: '이동 50분' });
  });
});

describe('홈 이동 중 · 도착 줄 (tripCardOf, 11/19)', () => {
  const departed = plan({ departedAt: at('8:55') }); // 이동 50분
  const arrived = plan({ departedAt: at('8:55'), arrivedAt: at('9:48') });

  it('출발 뒤 도착 전 — 이동 중 · 출발 + 예상 이동분이 도착 예정', () => {
    expect(tripCardOf(departed, at('9:10'))).toEqual({ stage: 'MOVING', title: '이동 중 · 오전 9:45 도착 예정', summary: '오전 10:00 팀 주간회의 · 세종대학교' });
  });

  it('도착하면 도착했어요 + 시각', () => {
    expect(tripCardOf(arrived, at('9:50'))).toMatchObject({ stage: 'ARRIVED', title: '도착했어요 오전 9:48' });
  });

  it('출발 기록이 없으면 줄 없음(아침 카드가 보임), 도착 기록만 있어도 도착은 보임', () => {
    expect(tripCardOf(plan(), at('9:10'))).toBeNull();
    expect(tripCardOf(plan({ arrivedAt: at('9:48') }), at('9:50'))?.stage).toBe('ARRIVED');
    expect(tripCardOf(null, at('9:10'))).toBeNull();
  });

  it('약속 + 60분까지만 — 그 뒤에는 사라짐', () => {
    expect(tripCardOf(arrived, at('11:00'))).not.toBeNull();
    expect(tripCardOf(arrived, at('11:01'))).toBeNull();
    expect(tripCardOf(departed, at('11:01'))).toBeNull();
  });

  it('출발하면 아침 카드는 빠지고 이 줄이 그 자리를 이음', () => {
    expect(morningCardVisible(departed, at('9:10'))).toBe(false);
    expect(tripCardOf(departed, at('9:10'))).not.toBeNull();
  });
});
