import { describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { kst } from '@/mocks/data';

import { useWeekAiSummary } from '../hooks/useRecords';

// useWeekAiSummary — 그 주 일기 지문(journalKey)이 바뀔 때만 다시 읽음 (당겨서 새로고침: 일수가 같아도 글만 고치면 다시 읽음)
const mockGetWeekAiSummary = jest.fn(async () => null);
jest.mock('@/features/records/api', () => ({
  ...jest.requireActual<object>('@/features/records/api'),
  getWeekAiSummary: () => mockGetWeekAiSummary(),
}));
// 화면에 들어온 것처럼 한 번 (effect와 같게)
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => jest.requireActual<typeof import('react')>('react').useEffect(effect, [effect]),
}));

function Probe({ period, journalKey }: { period: Date; journalKey: string }) {
  useWeekAiSummary(period, journalKey);
  return null;
}

describe('useWeekAiSummary', () => {
  it('지문이 같으면 다시 안 읽고, 글만 고쳐 지문이 바뀌면 다시 읽음', async () => {
    const period = kst(22, 0);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(Probe, { period, journalKey: 'k1' }));
    });
    expect(mockGetWeekAiSummary).toHaveBeenCalledTimes(1);
    await act(async () => r.update(createElement(Probe, { period, journalKey: 'k1' }))); // 새로고침했지만 그대로
    expect(mockGetWeekAiSummary).toHaveBeenCalledTimes(1);
    await act(async () => r.update(createElement(Probe, { period, journalKey: 'k2' }))); // 같은 일수, 글만 고침
    expect(mockGetWeekAiSummary).toHaveBeenCalledTimes(2);
  });
});
