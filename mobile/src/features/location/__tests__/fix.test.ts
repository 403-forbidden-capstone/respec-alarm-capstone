import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { eraseDetection, settleCorrectedDetection, undoErase } from '../fix';
import { commit, loadState } from '../store';

// [아니에요] 정정 — 서버 값 지우기 · 폰 기억 맞춤 뒤 알림창에 남은 감지 안내를 거둠 (부르는 것만 확인, 각 단계는 가짜)
const mockReject = jest.fn<(args: unknown) => Promise<unknown>>();
const mockUndoReject = jest.fn<(snapshot: unknown) => Promise<boolean>>();
jest.mock('../api', () => ({ rejectDetection: (a: unknown) => mockReject(a), undoReject: (s: unknown) => mockUndoReject(s) }));
const mockForget = jest.fn<(d: unknown, o?: unknown) => Promise<boolean>>();
const mockRestore = jest.fn<(d: unknown) => Promise<boolean>>();
jest.mock('../correct', () => ({ forgetGeoDetection: (d: unknown, o?: unknown) => mockForget(d, o), restoreGeoDetection: (d: unknown) => mockRestore(d) }));
const mockWithdraw = jest.fn<(link: unknown) => void>();
jest.mock('../notice', () => ({ withdrawDetectionNotice: (l: unknown) => mockWithdraw(l) }));
jest.mock('../register', () => ({ syncLocation: async () => {} }));
jest.mock('@/lib/alarmSync', () => ({ syncNow: async () => {} }));

const P = 'p1';
const AT = Date.parse('2025-05-22T08:30:00+09:00');

beforeEach(() => {
  jest.clearAllMocks();
  mockForget.mockResolvedValue(true);
  mockUndoReject.mockResolvedValue(true);
  mockRestore.mockResolvedValue(true);
});

describe('eraseDetection — 감지 안내 알림 거두기', () => {
  it('지우고 나면 그 감지의 알림을 거둠 (서버 값 시각 = 알림 시각이면 한 번)', async () => {
    mockReject.mockResolvedValue({ participantId: P, kind: 'DEPART', at: new Date(AT) });
    await eraseDetection({ participantId: P, kind: 'DEPART', at: AT }, 'home' as never);
    expect(mockWithdraw.mock.calls).toEqual([[{ kind: 'DEPART', participantId: P, at: AT }]]);
  });

  it('서버 값 시각이 폰이 잡은 시각과 다르면 둘 다 시도 (도착도 같음)', async () => {
    mockReject.mockResolvedValue({ participantId: P, kind: 'ARRIVE', at: new Date(AT + 60_000) });
    await eraseDetection({ participantId: P, kind: 'ARRIVE', at: AT }, 'home' as never);
    expect(mockWithdraw.mock.calls).toEqual([
      [{ kind: 'ARRIVE', participantId: P, at: AT }],
      [{ kind: 'ARRIVE', participantId: P, at: AT + 60_000 }],
    ]);
  });

  it('지울 값이 없으면(null) 거두지 않음, 되돌리기에서는 다시 띄우지 않음', async () => {
    mockReject.mockResolvedValue(null);
    mockForget.mockResolvedValue(false);
    expect(await eraseDetection({ participantId: P, kind: 'DEPART', at: AT }, 'home' as never)).toBeNull();
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(await undoErase({ participantId: P, kind: 'DEPART', at: new Date(AT) } as never)).toBe(true);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

describe('settleCorrectedDetection — 대화(A02) 정정 뒤 [아니에요]와 같은 정리 (G10)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('서버의 위치 값 시각과 폰이 기억하는 판정 시각 둘 다 — 폰 기억 맞춤 + 안내 거두기', async () => {
    const state = await loadState();
    await commit({ state: { ...state, arrived: [{ participantId: P, at: AT + 120_000, appointmentAt: AT + 3_600_000 }] } });
    await settleCorrectedDetection({ participantId: P, kind: 'ARRIVE', serverAt: AT });
    expect(mockForget.mock.calls).toEqual([
      [{ participantId: P, kind: 'ARRIVE', at: AT }, { voidAlways: true }], // 서버 값은 폰 기억에 없어도 voided로
      [{ participantId: P, kind: 'ARRIVE', at: AT + 120_000 }, { voidAlways: false }],
    ]);
    expect(mockWithdraw.mock.calls).toEqual([[{ kind: 'ARRIVE', participantId: P, at: AT }], [{ kind: 'ARRIVE', participantId: P, at: AT + 120_000 }]]);
  });

  it('위치 값도 폰 기억도 없으면 아무것도 안 함', async () => {
    await settleCorrectedDetection({ participantId: P, kind: 'DEPART', serverAt: null });
    expect(mockForget).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('다른 참여 조건의 판정은 건드리지 않고, 정리가 실패해도 던지지 않음', async () => {
    const state = await loadState();
    await commit({ state: { ...state, arrived: [{ participantId: 'other', at: AT, appointmentAt: AT + 3_600_000 }] } });
    mockForget.mockRejectedValueOnce(new Error('저장소 오류'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settleCorrectedDetection({ participantId: P, kind: 'ARRIVE', serverAt: AT + 1 })).resolves.toBeUndefined();
    expect(mockForget.mock.calls.every(([d]) => (d as { participantId: string }).participantId === P)).toBe(true);
  });
});
