import { describe, expect, it } from '@jest/globals';

import {
  formatDate,
  formatDateParen,
  formatDateShort,
  formatRelative,
  formatTime,
  formatMinuteOfDay,
  formatTime24,
  josa,
  joinKo,
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
    expect(formatDateShort(morning)).toBe('5월 22일 목');
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
