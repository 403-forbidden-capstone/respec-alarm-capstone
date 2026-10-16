import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getNextAlarm } from '../api';
import type { NextAlarm } from '../types';

// api.ts가 함수 맨 앞에서 실데이터(real.ts)와 가짜를 나누는 패턴의 본보기 시험 — 다른 기능(records · routine · social)도 같은 모양으로 확인함
//   실데이터 모드면 real.ts로 넘기고 가짜 데이터를 건드리지 않음, 가짜 모드면 real.ts를 부르지 않음
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const mockRealNext = jest.fn<() => Promise<NextAlarm | null>>();
jest.mock('../real', () => ({ getNextAlarm: () => mockRealNext() }));

beforeEach(() => {
  mockIsMock = true;
  mockRealNext.mockReset();
});

describe('api.ts 가짜 · 실데이터 나누기 (getNextAlarm)', () => {
  it('실데이터 모드면 real.ts의 결과를 그대로 돌려줌', async () => {
    mockIsMock = false;
    mockRealNext.mockResolvedValue(null);
    await expect(getNextAlarm()).resolves.toBeNull();
    expect(mockRealNext).toHaveBeenCalledTimes(1);
  });

  it('실데이터 읽기 실패는 가짜로 바꾸지 않고 그대로 던짐 (화면이 LoadError로 보여 줌)', async () => {
    mockIsMock = false;
    mockRealNext.mockRejectedValue(new Error('network'));
    await expect(getNextAlarm()).rejects.toThrow('network');
  });

  it('가짜 모드면 real.ts를 부르지 않고 목업 일정에서 고름', async () => {
    const next = await getNextAlarm();
    expect(mockRealNext).not.toHaveBeenCalled();
    expect(next?.appointment.title).toBe('팀 주간회의');
  });
});
