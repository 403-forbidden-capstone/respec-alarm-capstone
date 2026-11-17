import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useLiveVoice, type LiveVoiceOptions } from '../hooks/useLiveVoice';

// 30초 무발화 자동 종료 · 앱이 뒤로 갈 때 닫기 — 소리 페이지(LiveFrame)는 가짜로 바꿔 페이지 메시지를 직접 넣음
type FrameProps = { html: string; onMessage: (raw: unknown) => void; sendRef?: { current: ((d: string) => void) | null } };
const mockFrames: FrameProps[] = [];
const mockToPage: string[] = [];
jest.mock('../components/LiveFrame', () => ({
  LiveFrame: (props: FrameProps) => {
    mockFrames.push(props);
    if (props.sendRef) props.sendRef.current = (d: string) => mockToPage.push(d);
    return null;
  },
}));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-11-17T22:00:00+09:00') }));

let appState: ((s: AppStateStatus) => void) | null = null;
const hook: { current: ReturnType<typeof useLiveVoice> | null } = { current: null };
let renderer: ReactTestRenderer;
const api = () => hook.current as ReturnType<typeof useLiveVoice>;
const log: string[] = [];

function Probe({ onTurn, options }: { onTurn: (me: string, ai: string) => Promise<boolean>; options: LiveVoiceOptions }) {
  const live = useLiveVoice(async () => ({ token: 't', model: 'm' }), onTurn, options);
  useEffect(() => {
    hook.current = live;
  });
  return live.frame;
}

async function mount(onTurn: (me: string, ai: string) => Promise<boolean> = async () => true, options: LiveVoiceOptions = {}) {
  await act(async () => {
    renderer = create(createElement(Probe, { onTurn, options: { onIdle: () => log.push('idle'), ...options } }));
  });
  await act(async () => {
    await api().start();
  });
}
const frame = () => mockFrames[mockFrames.length - 1] as FrameProps;
const page = (m: object, f = frame()) => act(() => f.onMessage(JSON.stringify(m)));
const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const stops = () => mockToPage.filter((d) => JSON.parse(d).type === 'stop').length;

beforeEach(() => {
  jest.useFakeTimers();
  mockFrames.length = 0;
  mockToPage.length = 0;
  log.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: AppStateStatus) => void) => {
    appState = fn;
    return { remove: () => {} };
  }) as never);
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('30초 무발화 자동 종료', () => {
  it('연결 뒤 AI가 아직 말하지 않았어도 30초 말이 없으면 끝냄 — 29초엔 아님, 페이지에 stop, 한 번만', async () => {
    await mount();
    await page({ type: 'live' });
    await wait(29_000);
    expect(log).toEqual([]);
    await wait(1_000);
    expect(log).toEqual(['idle']);
    expect(api().phase).toBe('idle');
    expect(stops()).toBe(1);
    await wait(120_000);
    act(() => api().stop()); // 사용자가 [완료]를 같이 눌러도
    expect(log).toEqual(['idle']);
  });

  it('AI가 40초 말해도 끊지 않고, 말이 끝나 마이크가 다시 열리면 새 30초', async () => {
    await mount();
    await page({ type: 'live' });
    await wait(5_000);
    await page({ type: 'mic', muted: true });
    await wait(40_000);
    expect([log, api().phase]).toEqual([[], 'live']);
    await page({ type: 'mic', muted: false });
    await wait(29_000);
    expect(log).toEqual([]);
    await wait(1_000);
    expect(log).toEqual(['idle']);
  });

  it('20초에 사용자가 말하면(받아쓰기) 새 30초', async () => {
    await mount();
    await page({ type: 'live' });
    await wait(20_000);
    await page({ type: 'me', text: '오늘' });
    await wait(29_000);
    expect(log).toEqual([]);
    await wait(1_000);
    expect(log).toEqual(['idle']);
  });

  it('29초에 말하기 시작하면 말하는 동안 끊지 않음 (받아쓰기가 늦게 와도)', async () => {
    await mount();
    await page({ type: 'live' });
    await wait(29_000);
    await page({ type: 'vad', active: true });
    await wait(6_000);
    expect(log).toEqual([]);
    await page({ type: 'vad', active: false });
    await wait(2_000);
    await page({ type: 'me', text: '내일 회의 있어' }); // 늦게 온 받아쓰기
    await wait(29_000);
    expect(log).toEqual([]);
  });

  it('주변 소음(받아쓰기 없는 소리 감지)이 이어져도 45초 안에 끝냄', async () => {
    await mount();
    await page({ type: 'live' });
    await page({ type: 'vad', active: true });
    await wait(45_000);
    expect(log).toEqual(['idle']);
  });

  it('끝내기 전에 마지막 차례(답 안 한 선택 질문 앞의 내 말)를 먼저 넘김', async () => {
    await mount(async (me) => {
      log.push(`turn:${me}`);
      return true;
    });
    await page({ type: 'live' });
    await page({ type: 'me', text: '오늘 너무 피곤했어' });
    await page({ type: 'ai', text: '특별히 힘들었던 일이 있었어요?' }); // 차례 끝(turn) 전에 말이 없음
    await wait(30_000);
    expect(log).toEqual(['turn:오늘 너무 피곤했어', 'idle']);
  });

  it('서버 처리(넘긴 차례) · 화면 작업(카드 저장 등) 중에는 끝내지 않고, 끝나면 새 30초', async () => {
    let done: (ok: boolean) => void = () => {};
    let busy = false;
    await mount(() => new Promise<boolean>((r) => (done = r)), { isBusy: () => busy });
    await page({ type: 'live' });
    await page({ type: 'me', text: '내일 10시 회의' });
    await page({ type: 'turn' });
    await wait(60_000);
    expect(log).toEqual([]);
    await act(async () => done(true));
    busy = true;
    await wait(60_000);
    expect(log).toEqual([]);
    busy = false;
    await wait(30_000);
    expect(log).toEqual(['idle']);
  });

  it('연결하지 않으면(글 대화) 타이머가 없음', async () => {
    await act(async () => {
      renderer = create(createElement(Probe, { onTurn: async () => true, options: { onIdle: () => log.push('idle') } }));
    });
    await wait(5 * 60_000);
    expect(log).toEqual([]);
  });

  it('10분 최대 연결 제한은 그대로', async () => {
    await mount(async () => true, { isBusy: () => true });
    await page({ type: 'live' });
    await wait(10 * 60_000);
    expect(api().phase).toBe('idle');
    expect(api().error).toMatch(/10분이 지나/);
    expect(log).toEqual([]);
  });
});

describe('앱이 뒤로 가면 마이크 · 연결을 닫음', () => {
  it('홈 · 다른 앱(background) · inactive → 바로 끝냄, 돌아와도 다시 켜지 않음', async () => {
    for (const state of ['background', 'inactive'] as const) {
      mockToPage.length = 0;
      await mount();
      await page({ type: 'live' });
      await page({ type: 'mic', muted: true }); // AI가 말하는 중이어도
      act(() => appState?.(state));
      expect([api().phase, stops(), api().frame]).toEqual(['idle', 1, null]);
      act(() => appState?.('active'));
      expect([api().phase, api().frame]).toEqual(['idle', null]);
      act(() => renderer.unmount());
    }
  });

  it('닫은 연결의 늦은 메시지는 새 연결에 섞이지 않음 · 다시 시작하면 앞 연결을 먼저 닫음', async () => {
    await mount();
    const old = frame();
    await page({ type: 'live' }, old);
    await act(async () => {
      await api().start(); // 켜진 채 다시 시작
    });
    expect(stops()).toBe(1);
    expect(api().phase).toBe('connecting');
    await page({ type: 'live' }, old); // 앞 페이지의 늦은 메시지
    await page({ type: 'me', text: '늦은 말' }, old);
    expect([api().phase, api().lines]).toEqual(['connecting', []]);
  });

  it('여러 번 끝내도 오류 없음', async () => {
    await mount();
    await page({ type: 'live' });
    act(() => {
      api().stop();
      api().stop();
      appState?.('background');
    });
    expect(api().phase).toBe('idle');
  });
});
