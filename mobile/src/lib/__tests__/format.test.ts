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
  joinKo,
  keepWords,
  minuteOfDay,
  spokenTime,
  timeParts,
} from '../format';

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
});
