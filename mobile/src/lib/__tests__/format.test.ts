import { describe, expect, it } from '@jest/globals';

import {
  dropRepeatedAmpm,
  formatDate,
  formatDateParen,
  formatDateShort,
  formatMinuteOfDay,
  formatRelative,
  formatTime,
  formatTime24,
  josa,
  lifeDayKey,
  joinKo,
  keepWords,
  keepWordsIfWrappable,
  minuteOfDay,
  spokenTime,
  timeParts, formatWait } from '../format';

// 5월 22일 오전 7:55 (한국) = 5월 21일 22:55 (UTC)
const morning = new Date('2025-05-21T22:55:00Z');

describe('시각 표기 (한국 시간)', () => {
  it('오전 · 오후와 12시를 목업처럼 씀', () => {
    expect(formatTime(morning)).toBe('오전 7:55');
    expect(formatTime(new Date('2025-05-22T03:00:00Z'))).toBe('오후 12:00');
    expect(formatTime(new Date('2025-05-21T15:05:00Z'))).toBe('오전 12:05');
    expect(timeParts(morning)).toEqual({ ampm: '오전', hm: '7:55' });
    expect(formatTime24(new Date('2025-05-21T12:30:00Z'))).toBe('21:30');
    expect(minuteOfDay(morning)).toBe(475);
  });

  it('날짜는 한국 날짜로 바뀜', () => {
    expect(formatDate(morning)).toBe('5월 22일 목요일');
    expect(formatDateShort(morning)).toBe('5월 22일 (목)');
    expect(formatDateParen(morning)).toBe('5월 22일 (목)');
  });

  it('남은 시간 · 음성 안내 시각', () => {
    expect(formatRelative(morning, new Date('2025-05-21T23:00:00Z'))).toBe('5분 뒤');
    expect(formatRelative(morning, new Date('2025-05-22T00:00:00Z'))).toBe('1시간 5분 뒤');
    expect(formatRelative(morning, morning)).toBe('지금');
    expect(spokenTime(new Date('2025-05-22T01:00:00Z'))).toBe('오전 10시');
    expect(spokenTime(new Date('2025-05-22T05:30:00Z'))).toBe('오후 2시 30분');
  });
});

describe('조사', () => {
  it('받침에 따라 고름', () => {
    expect(josa('수연', '이', '가')).toBe('수연이');
    expect(josa('지형님', '은', '는')).toBe('지형님은');
    expect(josa('회의', '이', '가')).toBe('회의가');
  });

  it('여럿을 이어 씀', () => {
    expect(joinKo(['수연님'])).toBe('수연님');
    expect(joinKo(['수연님', '지형님'])).toBe('수연님과 지형님');
    expect(joinKo(['수연님', '지형님', '준성님'])).toBe('수연님, 지형님과 준성님');
  });
});

describe('formatMinuteOfDay', () => {
  it('0시부터 분을 HH:MM으로, 하루를 넘으면 다음 날 시각', () => {
    expect(formatMinuteOfDay(1290)).toBe('21:30');
    expect(formatMinuteOfDay(5)).toBe('00:05');
    expect(formatMinuteOfDay(1440 + 30)).toBe('00:30');
  });
});

describe('keepWords', () => {
  it('줄은 시각과 종류 사이 · 상태 앞에서만 바뀜, 보이는 글자는 그대로', () => {
    const out = keepWords('오후 12:28 기상 · 지남');
    expect(out.replace(/\u2060/g, '').replace(/\u00A0/g, ' ')).toBe('오후 12:28 기상 · 지남');
    expect(out).toBe('오\u2060후\u00A012:28 기\u2060상 ·\u00A0지\u2060남');
    expect(keepWords('7:00 AM')).toBe('7:00 AM');
  });

  it('두 번 걸어도 결과가 같음 (공통 Text와 화면이 겹쳐도 안전)', () => {
    const once = keepWords('오후 12:28 기상 · 지남');
    expect(keepWords(once)).toBe(once);
  });
});

describe('keepWordsIfWrappable', () => {
  it('띄어쓰기가 있는 한글 글에만 걸고, 숫자 · 한 단어 · 영문은 그대로', () => {
    expect(keepWordsIfWrappable('기상 확인')).toBe(keepWords('기상 확인'));
    expect(keepWordsIfWrappable('기상')).toBe('기상');
    expect(keepWordsIfWrappable('7:55')).toBe('7:55');
    expect(keepWordsIfWrappable('Re:Spec Alarm')).toBe('Re:Spec Alarm');
    expect(keepWordsIfWrappable('https://example.com/가나다')).toBe('https://example.com/가나다');
  });

  it('이미 keepWords를 건 글에 다시 걸어도 같음', () => {
    const done = keepWords('집에서 나서는 시각');
    expect(keepWordsIfWrappable(done)).toBe(done);
  });
});

describe('dropRepeatedAmpm', () => {
  it('앞 줄과 같은 오전 · 오후만 빼고, 바뀌는 곳은 남김', () => {
    expect(dropRepeatedAmpm(['오전 8:00 기상', '오전 8:30 준비', '오후 1:10 출발', '오후 1:40 도착'])).toEqual([
      '오전 8:00 기상',
      '8:30 준비',
      '오후 1:10 출발',
      '1:40 도착',
    ]);
  });
  it('오전 · 오후가 없는 줄은 그대로, 하나뿐이면 그대로', () => {
    expect(dropRepeatedAmpm(['오전 8:00 기상'])).toEqual(['오전 8:00 기상']);
    expect(dropRepeatedAmpm(['08:00 기상', '08:30 준비'])).toEqual(['08:00 기상', '08:30 준비']);
    expect(dropRepeatedAmpm([])).toEqual([]);
  });
  it('하루를 넘기는 체인은 바뀌는 곳을 남김, 뒤에 붙은 표시(지남 · 꺼짐)는 영향 없음', () => {
    expect(dropRepeatedAmpm(['오후 11:30 준비', '오전 12:10 출발'])).toEqual(['오후 11:30 준비', '오전 12:10 출발']);
    expect(dropRepeatedAmpm(['오전 8:00 기상 · 지남', '오전 8:30 준비 · 꺼짐'])).toEqual(['오전 8:00 기상 · 지남', '8:30 준비 · 꺼짐']);
  });
});

describe('formatWait', () => {
  it('60초까지는 초, 1시간 전까지는 분(올림), 그 뒤는 시간(올림)', () => {
    expect(formatWait(1)).toBe('1초');
    expect(formatWait(42.2)).toBe('43초');
    expect(formatWait(60)).toBe('60초');
    expect(formatWait(61)).toBe('2분');
    expect(formatWait(3599)).toBe('60분');
    expect(formatWait(3600)).toBe('1시간');
    expect(formatWait(30000)).toBe('9시간');
  });

  it('0 이하도 1초로', () => {
    expect(formatWait(0)).toBe('1초');
  });
});

describe('lifeDayKey — AI 대화방 · 하루 기록 기준일 (KST 새벽 4시)', () => {
  const k = (iso: string) => lifeDayKey(new Date(iso));
  it('23:59 · 00:00 · 03:59는 전날, 04:00부터 그날', () => {
    expect(k('2026-11-11T23:59:00+09:00')).toBe('2026-11-11');
    expect(k('2026-11-12T00:00:00+09:00')).toBe('2026-11-11');
    expect(k('2026-11-12T03:59:59+09:00')).toBe('2026-11-11');
    expect(k('2026-11-12T04:00:00+09:00')).toBe('2026-11-12');
  });
  it('월말 · 연말', () => {
    expect(k('2026-12-01T01:00:00+09:00')).toBe('2026-11-30');
    expect(k('2027-01-01T03:00:00+09:00')).toBe('2026-12-31');
    expect(k('2027-01-01T04:00:00+09:00')).toBe('2027-01-01');
  });
});
