import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError } from '@/lib/edge';

import { createFake } from '../__fixtures__/fakeSupabase';
import { GROUP, SUYEON } from '../__fixtures__/seed';
import { pingResultOf } from '../real/wake';
import * as real from '../real';
import {
  receivedPingLine,
  WAKE_PING_ALREADY_UP,
  WAKE_PING_DAILY_LIMIT,
  WAKE_PING_NO_TOKENS,
  WAKE_PING_NOT_RINGING,
  WAKE_PING_OFF,
  wakePingLocks,
  wakePingNote,
} from '../wakeTexts';

// 친구 8장 앱 층 — G03 [깨우기] 결과 · 받은 깨우기 한 줄 · 호출 모양 (시험케이스 8-04 ~ 8-10 · 8-14 · 8-16 · 8-17 · 8-18, 세션약속 `my_wake_pings` · notify 깨우기)
//   판정 · 횟수(5분 1번 · 하루 3번) · 직전 재확인은 서버가 함 — 여기서는 요청 모양 · 응답 상태 → 문구 · 버튼 잠금을 확인
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));
const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/lib/edge', () => {
  const actual = jest.requireActual<typeof import('@/lib/edge')>('@/lib/edge');
  return { ...actual, callEdge: (name: string, body?: Record<string, unknown>) => mockCallEdge(name, body) };
});

const ok = (data: unknown) => ({ data, error: null });
const T = new Date('2026-11-10T23:15:00.000Z'); // 한국 8:15 (다음 날 아침)

beforeEach(() => {
  mockFake.reset();
  mockCallEdge.mockReset();
});

describe('서버 ping 상태 → 앱 결과', () => {
  it('OK(몇 번째 · 다음 가능 시각) · WAIT(다음 가능 시각)', () => {
    expect(pingResultOf({ sent: 1, ping: { status: 'OK', count: 1, limit: 3, next_at: T.toISOString() } })).toEqual({ status: 'OK', count: 1, limit: 3, nextAt: T });
    expect(pingResultOf({ ping: { status: 'WAIT', next_at: T.toISOString() } })).toEqual({ status: 'WAIT', nextAt: T });
    expect(pingResultOf({ ping: { status: 'WAIT' } })).toEqual({ status: 'WAIT', nextAt: null });
  });

  it('나머지 상태는 그대로 — 한도 · 아직 안 울림 · 이미 일어남 · 꺼짐 · 토큰 없음', () => {
    for (const status of ['DAILY_LIMIT', 'NOT_RINGING', 'ALREADY_UP', 'OFF', 'NO_TOKENS'] as const) {
      expect(pingResultOf({ ping: { status } })).toEqual({ status });
    }
  });

  it('모르는 상태 · 상태가 없는 응답은 오류 (성공으로 착각하지 않게)', () => {
    expect(() => pingResultOf({ ping: { status: 'SOMETHING_NEW' } })).toThrow();
    expect(() => pingResultOf({ sent: 1 })).toThrow();
    expect(() => pingResultOf(null)).toThrow();
  });
});

describe('sendWakePing 호출', () => {
  it('받는 사람 + 어느 그룹 화면인지만 보냄 (제목 · 본문 · data 없음, 서버가 받는 사람 판정)', async () => {
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0, ping: { status: 'OK', count: 2, limit: 3, next_at: T.toISOString() } });
    await real.sendWakePing(GROUP, SUYEON);
    expect(mockCallEdge).toHaveBeenCalledWith('notify', { kind: 'WAKE_PING', targetUserId: SUYEON, groupId: GROUP });
  });

  it('기상이 안 보이는 사람(서버 403) · 차단 쌍은 받기를 끈 것과 같은 말 — 사실을 구분하지 않음 (8-10 · 8-11 · 8-12 · 8-35)', async () => {
    mockCallEdge.mockRejectedValue(new EdgeError('FORBIDDEN', { status: 403 }));
    await expect(real.sendWakePing(GROUP, SUYEON)).resolves.toEqual({ status: 'OFF' });
  });

  it('오프라인 · 서버 오류는 그대로 던짐 (화면이 "다시 해 주세요")', async () => {
    mockCallEdge.mockRejectedValue(new EdgeError('NETWORK'));
    await expect(real.sendWakePing(GROUP, SUYEON)).rejects.toBeInstanceOf(EdgeError);
  });
});

describe('G03 버튼 아래 한 줄 · 잠금 (8-17)', () => {
  it("보냄은 '1/3 · 8:15부터 다시' 모양, 5분 안에 또 누르면 '8:15부터 다시'", () => {
    expect(wakePingNote({ status: 'OK', count: 1, limit: 3, nextAt: T })).toMatch(/^1\/3 · .*8:15.*부터 다시$/);
    expect(wakePingNote({ status: 'WAIT', nextAt: T })).toMatch(/^.*8:15.*부터 다시$/);
  });

  it('한도 · 꺼짐 · 이미 일어남 · 토큰 없음 · 아직 안 울림 문구', () => {
    expect(wakePingNote({ status: 'DAILY_LIMIT' })).toBe(WAKE_PING_DAILY_LIMIT);
    expect(wakePingNote({ status: 'OFF' })).toBe('지금은 깨울 수 없어요');
    expect(WAKE_PING_OFF).not.toMatch(/끄|껐|받기/); // 꺼 둔 사실이 글자로 안 드러남
    expect(wakePingNote({ status: 'ALREADY_UP' })).toBe(WAKE_PING_ALREADY_UP);
    expect(wakePingNote({ status: 'NO_TOKENS' })).toBe(WAKE_PING_NO_TOKENS);
    expect(wakePingNote({ status: 'NOT_RINGING' })).toBe(WAKE_PING_NOT_RINGING);
  });

  it('잠그는 결과: 보냄 · 기다림 · 한도 · 꺼짐 · 이미 일어남. 토큰 없음(횟수 안 셈) · 아직 안 울림은 다시 누를 수 있음', () => {
    expect(wakePingLocks({ status: 'OK', count: 1, limit: 3, nextAt: T })).toBe(true);
    expect(wakePingLocks({ status: 'WAIT', nextAt: T })).toBe(true);
    expect(wakePingLocks({ status: 'DAILY_LIMIT' })).toBe(true);
    expect(wakePingLocks({ status: 'OFF' })).toBe(true);
    expect(wakePingLocks({ status: 'ALREADY_UP' })).toBe(true);
    expect(wakePingLocks({ status: 'NO_TOKENS' })).toBe(false);
    expect(wakePingLocks({ status: 'NOT_RINGING' })).toBe(false);
  });
});

describe('받은 깨우기 한 줄 (8-18)', () => {
  it('my_wake_pings 행 → 보낸 사람 이름 · 받은 시각 (최신 순 그대로)', async () => {
    mockFake.answerRpc('my_wake_pings', ok([{ sender_id: SUYEON, sender_nickname: '수연', sent_at: '2026-11-10T22:12:00.000Z' }]));
    await expect(real.getReceivedWakePings()).resolves.toEqual([{ senderId: SUYEON, senderName: '수연', at: new Date('2026-11-10T22:12:00.000Z') }]);
  });

  it("'수연님이 7:12에 깨웠어요', 여러 번이면 가장 최근 것에 '오늘 n번', 없으면 줄 없음", () => {
    const at = new Date('2026-11-10T22:12:00.000Z'); // 한국 7:12
    expect(receivedPingLine([{ senderName: '수연', at }])).toMatch(/^수연님이 .*7:12.*에 깨웠어요$/);
    expect(receivedPingLine([{ senderName: '수연', at }, { senderName: '민수', at }])).toMatch(/에 깨웠어요 · 오늘 2번$/);
    expect(receivedPingLine([])).toBeNull();
  });
});
