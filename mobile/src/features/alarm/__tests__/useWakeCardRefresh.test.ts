import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useWakeCardRefresh, WAKE_POLL_MS } from '../hooks/useWakeCardRefresh';

// 홈 "기상 확인 중" 카드 — 카드가 있는 동안만 15초마다 홈을 다시 읽음 (판정이 읽을 때 확정되므로)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});

const mockReload = jest.fn<() => Promise<void>>();

function Probe({ active }: { active: boolean }) {
  useWakeCardRefresh(active, mockReload);
  return null;
}

let tree: ReactTestRenderer;
const render = (active: boolean) => {
  act(() => {
    if (!tree) tree = create(createElement(Probe, { active }));
    else tree.update(createElement(Probe, { active }));
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockReload.mockReset();
  mockReload.mockResolvedValue();
  tree = undefined as unknown as ReactTestRenderer;
});

afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

describe('useWakeCardRefresh', () => {
  it('기상 카드가 있으면 15초마다 다시 읽음', () => {
    render(true);
    expect(mockReload).not.toHaveBeenCalled();
    act(() => void jest.advanceTimersByTime(WAKE_POLL_MS));
    expect(mockReload).toHaveBeenCalledTimes(1);
    act(() => void jest.advanceTimersByTime(WAKE_POLL_MS * 2));
    expect(mockReload).toHaveBeenCalledTimes(3);
  });

  it('기상 카드가 없으면 읽지 않음', () => {
    render(false);
    act(() => void jest.advanceTimersByTime(WAKE_POLL_MS * 5));
    expect(mockReload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('카드가 사라지면 멈추고, 화면이 사라져도 타이머가 남지 않음', () => {
    render(true);
    act(() => void jest.advanceTimersByTime(WAKE_POLL_MS));
    render(false);
    expect(jest.getTimerCount()).toBe(0);
    act(() => void jest.advanceTimersByTime(WAKE_POLL_MS * 3));
    expect(mockReload).toHaveBeenCalledTimes(1);
    render(true);
    act(() => tree.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('H08과 같은 15초', () => {
    expect(WAKE_POLL_MS).toBe(15_000);
  });
});
