import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { announce, flushActions } from '../actions';
import { commit, loadActions } from '../store';
import type { GeoAction } from '../transitions';

// 못 쓴 기록 보내기 뒤 도착 안내 — 서버 쓰기 · 안내는 가짜로 두고 부른 내용만 확인
const mockRecord = jest.fn<(input: Record<string, unknown>) => Promise<unknown>>();
const mockNotice = jest.fn<(action: GeoAction) => void>();
jest.mock('@/features/alarm/participantTimes', () => ({ recordParticipantTimes: (input: Record<string, unknown>) => mockRecord(input) }));
jest.mock('../notice', () => ({ onDetectionNotice: (action: GeoAction) => mockNotice(action) }));
jest.mock('@/lib/mode', () => ({ isMock: () => false }));
let mockNowMs = 0;
jest.mock('@/lib/clock', () => ({ now: () => new Date(mockNowMs) }));

const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const ARRIVE = { type: 'ARRIVE', participantId: 'p1', at: at('09:52') } as const;
const DEPART = { type: 'DEPART', participantId: 'p1', at: at('08:30') } as const;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // 실패 경로의 개발용 로그를 조용히
  mockNotice.mockReset();
  mockRecord.mockReset();
  mockRecord.mockResolvedValue({});
  mockNowMs = at('09:53');
});

describe('도착 안내 (flushActions)', () => {
  it('도착을 서버에 쓴 뒤에 안내 — 쓰기 다음에 부르고 보관함에서도 뺌', async () => {
    await commit({ actions: [ARRIVE] });
    await flushActions();
    expect(mockRecord).toHaveBeenCalledWith({ participantId: 'p1', arrivedAt: ARRIVE.at, source: 'LOCATION' });
    expect(mockNotice).toHaveBeenCalledTimes(1);
    expect(mockNotice).toHaveBeenCalledWith(ARRIVE);
    expect(mockRecord.mock.invocationCallOrder[0]).toBeLessThan(mockNotice.mock.invocationCallOrder[0]); // 쓰기 다음에 안내
    expect(await loadActions()).toEqual([]);
  });

  it('쓰기에 실패하면(일시 오류) 안내하지 않음 — 보관해 둔 채 다음에 다시, 그때 성공하면 안내', async () => {
    await commit({ actions: [ARRIVE] });
    mockRecord.mockRejectedValueOnce(new Error('network'));
    await flushActions();
    expect(mockNotice).not.toHaveBeenCalled();
    expect(await loadActions()).toEqual([ARRIVE]);
    await flushActions();
    expect(mockNotice).toHaveBeenCalledTimes(1);
    expect(await loadActions()).toEqual([]);
  });

  it('다시 해도 소용없는 오류로 버린 도착은 안내하지 않음 (서버에 없음)', async () => {
    await commit({ actions: [ARRIVE] });
    mockRecord.mockRejectedValueOnce({ code: '23503', message: 'fk' }); // 외래키 위반 등 — lib/alarmSync/events isPermanentInsertError
    await flushActions();
    expect(await loadActions()).toEqual([]);
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('출발(DEPART)을 써도 안내하지 않음 — 출발 안내는 이탈 순간(DEPART_PENDING)에 이미 나감', async () => {
    await commit({ actions: [DEPART] });
    await flushActions();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('감지 뒤 1시간이 넘어 쓰인 도착은 안내 생략 (기록은 씀)', async () => {
    await commit({ actions: [ARRIVE] });
    mockNowMs = ARRIVE.at + 61 * 60_000;
    await flushActions();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockNotice).not.toHaveBeenCalled();
    expect(await loadActions()).toEqual([]);
  });

  it('감지 뒤 정확히 1시간 안이면 안내', async () => {
    await commit({ actions: [ARRIVE] });
    mockNowMs = ARRIVE.at + 60 * 60_000;
    await flushActions();
    expect(mockNotice).toHaveBeenCalledTimes(1);
  });

  it('여러 개를 차례로 쓰면 도착마다 한 번씩만 안내', async () => {
    const second = { type: 'ARRIVE', participantId: 'p2', at: at('09:55') } as const;
    await commit({ actions: [DEPART, ARRIVE, second] });
    await flushActions();
    expect(mockNotice.mock.calls.map(([a]) => a)).toEqual([ARRIVE, second]);
  });
});

describe('안내 부르기 (announce)', () => {
  it('안내가 던져도 삼킴 — 나머지 안내는 계속', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockNotice.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => announce([{ type: 'DEPART_PENDING', participantId: 'p1', at: 1 }, { type: 'DEPART_CANCEL', participantId: 'p1', at: 1 }])).not.toThrow();
    expect(mockNotice).toHaveBeenCalledTimes(2);
  });
});
