import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement, useEffect } from 'react';
import { act, create } from 'react-test-renderer';

import { db, kst } from '@/mocks/data';

import { listDetections, type LocationDetection } from '../api';
import { REJECTED_VALUE } from '../detections';
import { useHomeDetections } from '../hooks/useHomeDetections';

// 홈 감지 정정 줄 — 가짜 데이터(저녁 시나리오: 오늘 = 5월 21일 오전 8:02 출발 · 8:52 도착)에서 [아니에요] → 줄이 빠짐 → 토스트 [되돌리기] → 줄이 돌아옴
//   훅을 react-test-renderer로 실제로 그림 (폰 기억 · 예약 맞춤은 가짜로 바꿔 부름만 확인)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}) } }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
jest.mock('@/lib/mode', () => ({ isMock: () => true }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2025-05-21T12:00:00Z') })); // 5월 21일 오후 9:00

type ToastOptions = { actionLabel?: string; duration?: number; onAction?: () => void };
const mockToast = jest.fn<(text: string, opts?: ToastOptions) => void>();
jest.mock('@/components/ui', () => ({ toast: (text: string, opts?: ToastOptions) => mockToast(text, opts) }));

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});

const mockForget = jest.fn<(d: unknown, o?: unknown) => Promise<boolean>>();
const mockRestore = jest.fn<(d: unknown) => Promise<boolean>>();
jest.mock('../correct', () => ({
  forgetGeoDetection: (d: unknown, o?: unknown) => mockForget(d, o),
  restoreGeoDetection: (d: unknown) => mockRestore(d),
}));
const mockSyncLocation = jest.fn<(o?: unknown) => Promise<void>>();
jest.mock('../register', () => ({ syncLocation: (o?: unknown) => mockSyncLocation(o) }));
const mockSyncNow = jest.fn<() => Promise<void>>();
jest.mock('@/lib/alarmSync', () => ({ syncNow: () => mockSyncNow() }));

const mockChanged = jest.fn<() => void>();
type Hook = ReturnType<typeof useHomeDetections>;
let latest: Hook | null = null;
const current = new Proxy({} as Hook, { get: (_, key) => (latest as Hook)[key as keyof Hook] }); // 늘 가장 나중에 그린 값을 읽음
function Probe() {
  const value = useHomeDetections({ onChanged: mockChanged });
  useEffect(() => {
    latest = value;
  });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
async function render() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  await flush();
  return renderer;
}
const kinds = () => current.rows.map((r) => r.kind);

beforeEach(() => {
  jest.clearAllMocks();
  mockForget.mockResolvedValue(true);
  mockRestore.mockResolvedValue(true);
  mockSyncLocation.mockResolvedValue(undefined);
  mockSyncNow.mockResolvedValue(undefined);
});

describe('useHomeDetections — 홈 감지 정정 줄', () => {
  it('오늘 위치로 잡은 출발 · 도착을 시각순으로 읽음', async () => {
    const renderer = await render();
    expect(current.rows.map((r) => [r.kind, r.at.getTime()])).toEqual([
      ['DEPART', kst(21, 482).getTime()],
      ['ARRIVE', kst(21, 532).getTime()],
    ]);
    await act(async () => renderer.unmount());
  });

  it('[아니에요] → 줄이 빠지고 토스트 [되돌리기](5초) → 누르면 줄이 돌아옴', async () => {
    const renderer = await render();
    const editLogs = db.editLogs.length;
    const depart = current.rows[0];

    await act(async () => {
      await current.reject(depart);
    });
    expect(kinds()).toEqual(['ARRIVE']);
    expect(mockForget).toHaveBeenCalledWith({ participantId: 'mock-21', kind: 'DEPART', at: kst(21, 482).getTime() }, { voidAlways: true }); // 폰 기억도 같이
    expect(db.editLogs.slice(editLogs)).toEqual([expect.objectContaining({ screen: 'H01', field: 'departed_at', editedValue: REJECTED_VALUE })]);
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [text, opts] = mockToast.mock.calls[0];
    expect(text).toBe('출발 오전 8:02 기록을 지웠어요');
    expect(opts).toMatchObject({ actionLabel: '되돌리기', duration: 5000 });
    expect(mockSyncNow).toHaveBeenCalled(); // 폰 예약 · 감시 계획 다시 맞춤
    expect(mockSyncLocation).toHaveBeenCalledWith({ ignoreThrottle: true });
    expect(mockChanged).toHaveBeenCalledTimes(1); // 홈의 다른 줄(아침 카드)도 다시 읽게

    mockToast.mockClear();
    await act(async () => {
      opts!.onAction!();
    });
    await flush();
    expect(kinds()).toEqual(['DEPART', 'ARRIVE']);
    expect(mockRestore).toHaveBeenCalledWith({ participantId: 'mock-21', kind: 'DEPART', at: kst(21, 482).getTime() });
    expect(mockToast).toHaveBeenCalledWith('출발 오전 8:02 기록을 되돌렸어요', undefined);
    expect(db.editLogs.length).toBe(editLogs); // 고친 값 기록도 지워짐
    expect(mockChanged).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it('이미 바뀐 기록(그 사이 다른 시각으로 바뀜)은 지우지 않고 알림', async () => {
    const renderer = await render();
    mockForget.mockResolvedValue(false); // 폰도 그 판정을 모름
    const stale: LocationDetection = { ...current.rows[0], at: kst(21, 400) };
    await act(async () => {
      await current.reject(stale);
    });
    expect(mockToast).toHaveBeenCalledWith('이미 바뀐 기록이에요', undefined);
    expect((await listDetections(kst(21, 0))).map((d) => d.kind)).toEqual(['DEPART', 'ARRIVE']); // 서버 값은 그대로
    expect(mockSyncNow).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('지우는 중 실패하면 던지지 않고 토스트로, 줄은 그대로', async () => {
    const renderer = await render();
    mockForget.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await current.reject(current.rows[1]);
    });
    expect(mockToast).toHaveBeenCalledWith('정정하지 못했어요. 연결을 확인하고 다시 시도해 주세요.', undefined);
    expect(kinds()).toEqual(['DEPART', 'ARRIVE']);
    await act(async () => renderer.unmount());
  });
});
