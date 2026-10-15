import { afterEach, describe, expect, it } from '@jest/globals';

import { getJournal } from '@/features/routine/api';
import { UserError } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { db, kst } from '@/mocks/data';

import {
  applySuggestion,
  getDay,
  getMonth,
  getPendingSuggestion,
  getSuggestion,
  getWeek,
  ignoreSuggestion,
  reopenSuggestion,
  undoSuggestion,
  weekEmptyText,
} from '../api';
import { suggestionPhase } from '../suggestion';

describe('R02 월간', () => {
  it('목업 달(2025년 5월): 앞 빈칸 3 · 지난 평일 완료 · 주말 일부 · 오늘 · 미래', async () => {
    const m = await getMonth(2025, 5);
    expect([m.title, m.leadingBlanks, m.days.length]).toEqual(['2025년 5월', 3, 31]);
    const day = (n: number) => m.days[n - 1];
    expect(day(21).mark).toBe('done'); // 수
    expect(day(18).mark).toBe('partial'); // 일
    expect([day(22).isToday, day(22).mark]).toEqual([true, 'none']); // 기상 확인 전
    expect([day(23).isFuture, day(23).mark]).toEqual([true, 'none']);
  });

  it('목업에 없는 달은 기록 없이 달력만', async () => {
    const m = await getMonth(2025, 6);
    expect([m.title, m.leadingBlanks, m.days.length]).toEqual(['2025년 6월', 6, 30]);
    expect(m.days.every((d) => d.mark === 'none' && d.isFuture && !d.isToday)).toBe(true);
    const april = await getMonth(2025, 4);
    expect(april.days.some((d) => d.isFuture)).toBe(false);
  });

  it('달력에 점이 있는 날은 일간을 열면 기록이 있음 (점 규칙 markOf는 D27이 열려 있어 그대로)', async () => {
    const m = await getMonth(2025, 5);
    for (const d of m.days.filter((x) => x.mark !== 'none')) {
      const record = await getDay(d.date);
      expect([d.day, record.actual.length > 0]).toEqual([d.day, true]);
    }
  });
});

describe('R02 주간', () => {
  it('이번 주(5월 19일): 날짜 줄 · 지난 사흘 요약', async () => {
    const w = await getWeek(kst(22, 475));
    expect([w.title, w.relative]).toEqual(['5월 19일 — 25일', '이번 주']);
    expect(w.strip.map((d) => `${d.weekday}${d.day}`)).toEqual(['월19', '화20', '수21', '목22', '금23', '토24', '일25']);
    expect(w.strip.map((d) => d.recorded)).toEqual([true, true, true, false, false, false, false]);
    expect(w.summary?.goalText).toBe('이번 주 3/3일');
    expect(w.summary?.bars.map((b) => b.label)).toEqual(['월 19', '화 20', '수 21']);
    expect(w.summary?.todayPending).toBe(true);
    // 평균 기상 오전 7:25 — 지난주(오전 7:33)보다 8분 빠름
    expect([w.summary && formatTime(w.summary.averageWake), w.summary?.averageText]).toEqual(['오전 7:25', '지난주보다 8분 빨라요']);
  });

  it('지난주(5월 12일)도 요약이 있음 — 기록된 평일 5일, 평균은 그 앞 주와 견줌', async () => {
    const w = await getWeek(kst(14, 0));
    expect([w.title, w.relative]).toEqual(['5월 12일 — 18일', '지난주']);
    expect(w.summary?.bars.map((b) => b.label)).toEqual(['월 12', '화 13', '수 14', '목 15', '금 16']);
    expect(w.summary?.bars.map((b) => b.score)).toEqual([82, 68, 79, 90, 74]);
    expect([w.summary?.goalRate, w.summary?.goalText]).toEqual([80, '지난주 4/5일']); // 70점 이상 4일
    expect(w.summary && formatTime(w.summary.averageWake)).toBe('오전 7:33'); // 이번 주가 견주는 지난주 평균
    expect(w.summary?.averageText).toBe('그 전 주보다 2분 늦어요'); // 5월 5일 주 평균 오전 7:31 — 지난주를 보는 중이라 "지난주보다"가 아님
    expect(w.summary?.todayPending).toBe(false); // 오늘이 없는 주
    // 주말은 일부 기록(점만) — 막대에는 안 들어감
    expect(w.strip.map((d) => d.recorded)).toEqual([true, true, true, true, true, true, true]);
  });

  it('앞 주 기록이 없으면 견주지 않음', async () => {
    const w = await getWeek(kst(1, 0)); // 4월 28일 주 — 5월 1·2일만 있고 그 앞 주는 목업에 없음
    expect(w.summary?.bars.map((b) => b.label)).toEqual(['목 1', '금 2']);
    expect(w.summary?.averageText).toBe('그 전 주 기록이 없어 견줄 수 없어요');
  });

  it('기록이 없는 주(앞날 · 목업에 없는 달)는 요약 없음', async () => {
    const next = await getWeek(kst(26, 0));
    expect([next.title, next.relative, next.summary]).toEqual(['5월 26일 — 6월 1일', '다음 주', null]);
    const april = await getWeek(kst(-10, 0)); // 4월 20일 주
    expect(april.summary).toBeNull();
  });

  it('오늘 기상을 확인하면 이번 주 요약에 오늘이 더해짐', async () => {
    db.me.wakeAt = kst(22, 485); // 기상 알람(오전 8:00)에서 5분 뒤
    try {
      const w = await getWeek(kst(22, 0));
      expect(w.summary?.bars.map((b) => `${b.label}:${b.score}`)).toEqual(['월 19:76', '화 20:92', '수 21:84', '목 22:88']);
      expect([w.summary?.goalText, w.summary?.todayPending]).toEqual(['이번 주 4/4일', false]);
    } finally {
      db.me.wakeAt = null;
    }
  });

  it('요약이 없는 주: 기록 점이 있으면 "요약 없음", 점도 없으면 "기록 없음"', async () => {
    const withDots = { ...(await getWeek(kst(12, 0))), summary: null };
    expect(weekEmptyText(withDots)).toBe('이 주 요약이 아직 없어요.');
    expect(weekEmptyText(await getWeek(kst(40, 0)))).toBe('이 주에는 기록이 없어요.');
  });
});

// D48 — 일간은 받은 날짜로 읽음
describe('R02 일간', () => {
  it('오늘은 db의 알람과 실제로 일어난 일 — 마지막 줄이 지금', async () => {
    const d = await getDay(kst(22, 0));
    expect([d.isToday, d.isFuture, d.journalWritten]).toEqual([true, false, false]);
    expect(d.planned.map((p) => `${formatTime(p.at)} ${p.label}`)).toEqual([
      '오전 8:00 기상 알람',
      '오전 8:30 준비 알람',
      '오전 9:00 출발 알람',
      '오전 9:50 도착 목표',
    ]);
  });

  it('실제로 일어난 일은 시각순 (넣은 순서와 상관없이)', async () => {
    const before = db.events.length;
    db.events.push(
      { at: kst(22, 9 * 60), label: '늦은 기록', source: '테스트' },
      { at: kst(22, 7 * 60), label: '이른 기록', source: '테스트' },
    );
    try {
      const d = await getDay(kst(22, 0));
      expect(d.actual.map((e) => e.label).slice(-2)).toEqual(['이른 기록', '늦은 기록']);
    } finally {
      db.events.length = before;
    }
  });

  it('지난 날은 그날 기록 — 어느 시각을 받아도 그날 0시, 일기가 있는 날은 표시', async () => {
    const d = await getDay(kst(21, 14 * 60));
    expect([d.date.getTime(), d.isToday, d.isFuture, d.journalWritten]).toEqual([kst(21, 0).getTime(), false, false, true]);
    expect(d.planned.map((p) => `${formatTime(p.at)} ${p.label} · ${p.source}`)).toEqual([
      '오전 7:15 기상 알람 · 수업',
      '오전 7:25 준비 알람 · 수업',
      '오전 8:00 출발 알람 · 수업',
      '오전 8:50 도착 목표 · 수업',
    ]);
    expect(d.actual.map((e) => `${formatTime(e.at)} ${e.label} · ${e.source}`)).toEqual([
      '오전 7:15 기상 알람 울림 · 자동',
      '오전 7:18 기상 알람 해제 · 자동',
      '오전 7:24 기상 확인 · 자동 판정',
      '오전 8:02 집 출발 · 자동 · 지오펜스',
      '오전 8:52 도착 · 지각 아님 · 자동 · 지오펜스',
    ]);
    expect(d.planned.some((p) => p.past) || d.actual.some((e) => e.past)).toBe(false); // 지난 날은 흐리게 하지 않음
  });

  it('지각한 날 · 주말(일부 기록) · 일기 없는 날', async () => {
    const late = await getDay(kst(13, 0));
    expect(late.actual.at(-1)).toMatchObject({ label: '도착 · 3분 지각' });
    expect(formatTime(late.actual.at(-1)!.at)).toBe('오전 9:03');
    expect(late.journalWritten).toBe(false);

    const weekend = await getDay(kst(17, 0));
    expect([weekend.planned.length, weekend.actual.map((e) => `${formatTime(e.at)} ${e.label} · ${e.source}`)]).toEqual([
      0,
      ['오후 8:50 준비물 저장 · 과제 출력물 · 직접 입력'],
    ]);
  });

  it('기록이 없는 날(목업에 없는 달)은 빈 기록, 앞날은 앞날 표시', async () => {
    const empty = await getDay(kst(0, 0)); // 4월 30일
    expect([empty.planned.length, empty.actual.length, empty.isFuture, empty.journalWritten]).toEqual([0, 0, false, false]);
    const future = await getDay(kst(24, 0));
    expect([future.planned.length, future.actual.length, future.isFuture]).toEqual([0, 0, true]);
  });
});

// D48 — 그날 일기(A03)를 날짜로 엶
describe('A03 지난 날 일기', () => {
  it('평일 몇 날에 일기가 있고 오늘 일기는 대화를 마쳐야 생김', async () => {
    const has = async (day: number) => (await getJournal(`2025-05-${String(day).padStart(2, '0')}`)) != null;
    expect(await Promise.all([16, 17, 18, 19, 20, 21, 22].map(has))).toEqual([true, false, false, true, true, true, false]);
  });

  it('일기 글 · 사실이 그날 기록과 같은 숫자로 쓰임', async () => {
    const j = await getJournal('2025-05-21');
    expect(j?.date.getTime()).toBe(kst(21, 0).getTime());
    expect(j?.text).toBe('오전 7:24에 일어났어요. 오전 8:02에 집을 나서 오전 8:52에 세종대학교에 도착했고, 수업에 늦지 않았어요.');
    expect(j?.facts.map((f) => `${formatTime(f.at)} ${f.label}`)).toEqual(['오전 7:24 기상 확인', '오전 8:02 집 출발', '오전 8:52 도착 · 지각 아님']);
    expect(j?.encouragement).toBe('그날도 약속 시간 안에 도착했어요. 이 흐름을 이어가요.'); // 지난 날은 "오늘도"가 아님
    expect([j?.edited, j?.suggestion.status, j?.routineId]).toEqual([false, 'PENDING', null]);
    expect((await getJournal('2025-05-16'))?.suggestion.status).toBe('REJECTED');
  });
});

// S01 — 적용 · 직접 수정(앞뒤 1분) · 다시 수정 · 되돌리기 · 무시 · 다시 보기 (목업 A.sugApply · sugApplyEdit · sugUndo · sugDismiss · sugReopen)
describe('S01 알람 조정 제안', () => {
  const eventCount = db.events.length;
  const prep = db.appointments.find((a) => a.id === 'a3')?.predictedPrepMinutes;
  const prepMinutes = () => db.appointments.find((a) => a.id === 'a3')?.predictedPrepMinutes;
  // 적용 전 시각 [상태, 기상, 준비, 출발]
  const times = async () => {
    const s = await getSuggestion('s1');
    return s && [s.status, formatTime(s.currentWake), s.currentPrepare && formatTime(s.currentPrepare), formatTime(s.depart)];
  };
  // 적용한 뒤 [상태, 적용 전보다 일찍(+) 늦게(−) 분, 기상, 준비, 출발]
  const appliedTimes = async () => {
    const s = await getSuggestion('s1');
    return s?.applied && [s.status, s.applied.minutes, formatTime(s.applied.wake), s.applied.prepare && formatTime(s.applied.prepare), formatTime(s.depart)];
  };

  afterEach(() => {
    db.suggestion.status = 'PENDING';
    db.suggestion.appliedMinutes = 0;
    const a3 = db.appointments.find((a) => a.id === 'a3');
    if (a3 && prep != null) a3.predictedPrepMinutes = prep;
    db.events.length = eventCount;
  });

  it('기다림: 수업 기상 오전 7:20 → 7:10 제안, 준비 7:30 · 출발 8:00, 30분 일찍 ~ 30분 늦게까지 고름', async () => {
    const s = await getSuggestion('s1');
    expect(s && [suggestionPhase(s.status), formatTime(s.currentWake), formatTime(s.proposedWake)]).toEqual([
      'pending',
      '오전 7:20',
      '오전 7:10',
    ]);
    expect(await times()).toEqual(['PENDING', '오전 7:20', '오전 7:30', '오전 8:00']);
    expect(s?.bounds).toEqual({ earlier: 30, later: 30 });
    expect(await getSuggestion('nope')).toBeNull();
  });

  it('제안대로 적용하면 APPLIED, 기상 · 준비가 같이 앞당겨지고(출발은 그대로) 홈 카드에서 빠짐', async () => {
    await applySuggestion('s1', 10);
    const s = await getSuggestion('s1');
    expect(s?.status).toBe('APPLIED');
    expect(await appliedTimes()).toEqual(['APPLIED', 10, '오전 7:10', '오전 7:20', '오전 8:00']);
    expect(await times()).toEqual(['APPLIED', '오전 7:20', '오전 7:30', '오전 8:00']); // 적용 전 시각은 그대로 남음
    expect(await getPendingSuggestion()).toBeNull();
    expect(db.events.at(-1)?.label).toBe('알람 조정 수락 · 10분 앞당김');
  });

  it('직접 고친 분으로 적용하면 EDITED', async () => {
    await applySuggestion('s1', 15);
    const s = await getSuggestion('s1');
    expect([s?.status, s && formatTime(s.proposedWake), s && formatTime(s.currentWake)]).toEqual(['EDITED', '오전 7:05', '오전 7:20']);
  });

  it('1분 단위로 고름 — 7분 일찍', async () => {
    await applySuggestion('s1', 7);
    expect(await appliedTimes()).toEqual(['EDITED', 7, '오전 7:13', '오전 7:23', '오전 8:00']);
    expect(db.events.at(-1)?.label).toBe('알람 조정 수락 · 7분 앞당김');
  });

  it('뒤로 늦춰도 적용됨 — 5분 늦게: 기상 7:25 · 준비 7:35, 출발은 그대로, 적용 전 시각은 7:20', async () => {
    await applySuggestion('s1', -5);
    expect(await appliedTimes()).toEqual(['EDITED', -5, '오전 7:25', '오전 7:35', '오전 8:00']);
    expect(await times()).toEqual(['EDITED', '오전 7:20', '오전 7:30', '오전 8:00']);
    expect(prepMinutes()).toBe(35);
    expect(db.events.at(-1)?.label).toBe('알람 조정 수락 · 5분 늦춤');
    expect(await getPendingSuggestion()).toBeNull();
  });

  it('적용한 뒤에도 바로 다시 고침 — 앞서 적용한 만큼은 걷어내고 새 값으로 (다시 고친 건 늘 EDITED)', async () => {
    await applySuggestion('s1', 10);
    await applySuggestion('s1', 7);
    expect(await appliedTimes()).toEqual(['EDITED', 7, '오전 7:13', '오전 7:23', '오전 8:00']);
    expect(prepMinutes()).toBe(47); // 원래 40 + 7, 17이 아님
    expect(db.events.at(-1)?.label).toBe('알람 조정 수정 · 7분 앞당김');

    await applySuggestion('s1', -3); // 일찍 → 늦게로 넘어가도 됨
    expect(await appliedTimes()).toEqual(['EDITED', -3, '오전 7:23', '오전 7:33', '오전 8:00']);
    expect(prepMinutes()).toBe(37);
    expect(db.events.at(-1)?.label).toBe('알람 조정 수정 · 3분 늦춤');

    await applySuggestion('s1', 10); // 제안 값으로 돌아가도 다시 고친 것이라 EDITED
    expect((await getSuggestion('s1'))?.status).toBe('EDITED');

    await undoSuggestion('s1'); // 되돌리기는 지금처럼 기다림 상태로 (D23 열림) — 원래 값
    expect(await times()).toEqual(['PENDING', '오전 7:20', '오전 7:30', '오전 8:00']);
    expect(prepMinutes()).toBe(40);
  });

  it('같은 값으로 두 번 적용되지 않음', async () => {
    await applySuggestion('s1', 15);
    await expect(applySuggestion('s1', 15)).rejects.toThrow('이미 이 시간으로 적용했어요');
    expect(prepMinutes()).toBe(55);
  });

  it('범위: 30분 일찍 ~ 30분 늦게 (준비 알람이 출발을 넘지 않게) — 끝 값은 되고 넘으면 이유와 함께 거절', async () => {
    await applySuggestion('s1', -30);
    expect(await appliedTimes()).toEqual(['EDITED', -30, '오전 7:50', '오전 8:00', '오전 8:00']); // 기상 ≤ 준비 ≤ 출발
    await applySuggestion('s1', 30); // 늦춘 뒤에도 범위는 적용 전 기준
    expect(await appliedTimes()).toEqual(['EDITED', 30, '오전 6:50', '오전 7:00', '오전 8:00']);
    await expect(applySuggestion('s1', 31)).rejects.toThrow('30분 일찍부터 30분 늦게까지 고를 수 있어요');
    await expect(applySuggestion('s1', -31)).rejects.toThrow('30분 일찍부터 30분 늦게까지 고를 수 있어요');
  });

  it('되돌리면 다시 기다림 · 원래 시각, 되돌림 기록이 남음', async () => {
    await applySuggestion('s1', 10);
    await undoSuggestion('s1');
    const s = await getSuggestion('s1');
    expect([s?.status, s && formatTime(s.currentWake)]).toEqual(['PENDING', '오전 7:20']);
    expect(db.events.at(-1)?.label).toBe('알람 조정 되돌림');
  });

  it('늦춰 적용한 것도 되돌리면 원래 값', async () => {
    await applySuggestion('s1', -12);
    await undoSuggestion('s1');
    expect(await times()).toEqual(['PENDING', '오전 7:20', '오전 7:30', '오전 8:00']);
    expect(prepMinutes()).toBe(40);
  });

  it('상태에 맞지 않는 되돌리기 · 무시 · 다시 보기는 이유와 함께 거절', async () => {
    await expect(undoSuggestion('s1')).rejects.toThrow('적용한 제안만 되돌릴 수 있어요');
    await expect(reopenSuggestion('s1')).rejects.toThrow('무시한 제안만 다시 볼 수 있어요');
    await applySuggestion('s1', 10);
    await expect(ignoreSuggestion('s1')).rejects.toThrow('기다리는 제안만 무시할 수 있어요');
    await undoSuggestion('s1');
  });

  it('0분 · 소수 분으로는 적용되지 않음', async () => {
    await expect(applySuggestion('s1', 0)).rejects.toThrow('조정할 시간을 골라 주세요');
    // 화면이 이유를 보여 주려면 UserError여야 함 (그냥 Error면 기본 문구)
    await expect(applySuggestion('s1', 0)).rejects.toBeInstanceOf(UserError);
    await expect(applySuggestion('s1', 1.5)).rejects.toThrow('조정할 시간을 골라 주세요');
    await expect(applySuggestion('nope', 10)).rejects.toThrow('제안을 찾을 수 없어요');
    expect((await getSuggestion('s1'))?.status).toBe('PENDING');
  });

  it('무시 → 다시 보기', async () => {
    await ignoreSuggestion('s1');
    expect(suggestionPhase((await getSuggestion('s1'))?.status ?? 'PENDING')).toBe('ignored');
    expect(await getPendingSuggestion()).toBeNull();
    await reopenSuggestion('s1');
    expect((await getSuggestion('s1'))?.status).toBe('PENDING');
  });

  it('제안 문구는 늘 앞당김 (직접 늦춰 적용해도 제안 자체는 그대로)', async () => {
    expect((await getPendingSuggestion())?.title).toBe('다음 알람을 10분 앞당겨 볼까요?');
    await applySuggestion('s1', -5);
    expect((await getSuggestion('s1'))?.title).toBe('다음 알람을 10분 앞당겨 볼까요?');
  });
});
