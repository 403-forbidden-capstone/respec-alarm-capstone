import { describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { kst } from '@/mocks/data';

import { weekDays, weekRelative, weekTitle } from '../calendar';
import { RecordsSection } from '../components/RecordsSection';
import type { WeekAiSummary, WeekRecord } from '../types';

// R02 주간 — 주를 넘기면 AI 주간 요약 칸이 새로 그려지는지 (#658 리뷰: 앞 주 글이 새 주 이름 아래 남던 문제)
//   훅은 실제 useLoadOn처럼 "기간이 바뀌어도 다시 읽는 동안 · 실패하면 앞 data를 그대로 둠"을 흉내 — 처음 그릴 때의 주 글만 가짐
const TODAY = kst(22, 0); // 2025-05-22 목
let mockAiNull = false; // 서버가 "요약할 일기 없음"(null)을 준 경우

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/skyTone', () => ({ useAccent: () => '#000000' }));
jest.mock('@/features/records/hooks/useRecords', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const cal = jest.requireActual<typeof import('../calendar')>('../calendar');
  const today = jest.requireActual<typeof import('@/mocks/data')>('@/mocks/data').kst(22, 0);
  const week = (period: Date): WeekRecord => ({
    title: cal.weekTitle(period),
    relative: cal.weekRelative(period, today),
    strip: cal.weekDays(period).map((date) => ({ date, weekday: '월', day: date.getDate(), isToday: false, isFuture: false, recorded: true })),
    summary: null,
    journalDays: 1,
    journalKey: cal.weekTitle(period),
  });
  const ai = (period: Date): WeekAiSummary => ({ text: `${cal.weekTitle(period)} 글`, dayCount: 1, period: cal.weekTitle(period), stale: false });
  return {
    useRecordToday: () => today,
    useWeekRecord: (period: Date) => ({ data: week(period), error: null, reload: async () => undefined, emptyText: '' }),
    useWeekAiSummary: (period: Date) => {
      const [data] = React.useState(() => (mockAiNull ? null : ai(period))); // 기간이 바뀌어도 앞 data를 둠 (useLoadOn과 같음)
      return { data, error: null, reload: async () => undefined };
    },
    useMonthRecord: () => ({ data: undefined, error: null, reload: async () => undefined }),
    useDayRecord: () => ({ data: undefined, error: null, reload: async () => undefined }),
  };
});

function render() {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(createElement(RecordsSection, { register: () => {} }));
  });
  // 글자 조각({relative} AI 주간 요약 같은 배열)은 이어 붙여 한 줄로
  const texts = () =>
    r.root
      .findAll((n) => typeof n.props.children === 'string' || (Array.isArray(n.props.children) && n.props.children.every((c: unknown) => typeof c === 'string')))
      .map((n) => (Array.isArray(n.props.children) ? (n.props.children as string[]).join('') : (n.props.children as string)));
  const press = (pick: (n: { props: Record<string, unknown> }) => boolean) => act(() => (r.root.find((n) => pick(n) && typeof n.props.onPress === 'function').props.onPress as () => void)());
  return { r, texts, press };
}

describe('RecordsSection 주간 AI 요약', () => {
  it('주를 넘기면 그 주 글 · 기간으로 새로 그림 (앞 주 글이 남지 않음)', () => {
    const v = render();
    v.press((n) => n.props.label === '자세히 ›'); // 펼치면 주간
    const thisWeek = weekTitle(TODAY);
    expect(v.texts()).toContain(`${thisWeek} 글`);

    v.press((n) => n.props.accessibilityLabel === '이전 주');
    const prev = kst(15, 0);
    expect(weekDays(prev)[0].getDate()).toBe(12);
    expect(v.texts()).toContain(`${weekRelative(prev, TODAY)} AI 주간 요약`);
    expect(v.texts()).toContain(`${weekTitle(prev)} 글`);
    expect(v.texts()).not.toContain(`${thisWeek} 글`);
  });

  it('앱은 일기가 있다고 읽었는데 서버가 요약할 일기 없음(null)을 주면 칸을 비우지 않고 알림', () => {
    mockAiNull = true;
    try {
      const v = render(); // 접힌 요약 (이번 주)
      expect(v.texts()).toContain('이번 주에는 요약할 일기가 없어요.');
      v.press((n) => n.props.label === '자세히 ›'); // 주간
      expect(v.texts()).toContain('이번 주에는 요약할 일기가 없어요.');
    } finally {
      mockAiNull = false;
    }
  });
});
