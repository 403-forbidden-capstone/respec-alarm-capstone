import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { db, kst } from '@/mocks/data';

import {
  applySuggestion,
  getDay,
  getMonth,
  getPendingSuggestion,
  getSuggestion,
  getWeek,
  ignoreSuggestion,
  recordToday,
  reopenSuggestion,
  undoSuggestion,
} from '../api';

// api.ts가 함수 맨 앞에서 실데이터(real.ts)와 가짜를 나누는지 — features/alarm/__tests__/realSwitch.test.ts와 같은 방식
//   실데이터 모드면 real.ts로 넘기고 가짜 데이터를 건드리지 않음, 가짜 모드면 real.ts를 부르지 않음
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const mockReal = {
  recordToday: jest.fn<() => Date>(),
  getMonth: jest.fn<(y: number, m: number) => Promise<unknown>>(),
  getWeek: jest.fn<(d: Date) => Promise<unknown>>(),
  getDay: jest.fn<(d: Date) => Promise<unknown>>(),
  getPendingSuggestion: jest.fn<() => Promise<unknown>>(),
  getSuggestion: jest.fn<(id: string) => Promise<unknown>>(),
  applySuggestion: jest.fn<(id: string, minutes: number) => Promise<void>>(),
  undoSuggestion: jest.fn<(id: string) => Promise<void>>(),
  ignoreSuggestion: jest.fn<(id: string) => Promise<void>>(),
  reopenSuggestion: jest.fn<(id: string) => Promise<void>>(),
};
jest.mock('../real', () => ({
  recordToday: () => mockReal.recordToday(),
  getMonth: (y: number, m: number) => mockReal.getMonth(y, m),
  getWeek: (d: Date) => mockReal.getWeek(d),
  getDay: (d: Date) => mockReal.getDay(d),
  getPendingSuggestion: () => mockReal.getPendingSuggestion(),
  getSuggestion: (id: string) => mockReal.getSuggestion(id),
  applySuggestion: (id: string, minutes: number) => mockReal.applySuggestion(id, minutes),
  undoSuggestion: (id: string) => mockReal.undoSuggestion(id),
  ignoreSuggestion: (id: string) => mockReal.ignoreSuggestion(id),
  reopenSuggestion: (id: string) => mockReal.reopenSuggestion(id),
}));

beforeEach(() => {
  mockIsMock = true;
  for (const fn of Object.values(mockReal)) fn.mockReset();
});

describe('records/api.ts 가짜 · 실데이터 나누기', () => {
  it('실데이터 모드면 읽기를 real.ts로 넘기고 그 결과를 그대로 돌려줌', async () => {
    mockIsMock = false;
    mockReal.getMonth.mockResolvedValue('month');
    mockReal.getWeek.mockResolvedValue('week');
    mockReal.getDay.mockResolvedValue('day');
    mockReal.getPendingSuggestion.mockResolvedValue(null);
    mockReal.getSuggestion.mockResolvedValue('suggestion');
    const anyDay = kst(22, 0);
    await expect(getMonth(2026, 10)).resolves.toBe('month');
    await expect(getWeek(anyDay)).resolves.toBe('week');
    await expect(getDay(anyDay)).resolves.toBe('day');
    await expect(getPendingSuggestion()).resolves.toBeNull();
    await expect(getSuggestion('id-1')).resolves.toBe('suggestion');
    expect(mockReal.getMonth).toHaveBeenCalledWith(2026, 10);
    expect(mockReal.getWeek).toHaveBeenCalledWith(anyDay);
    expect(mockReal.getDay).toHaveBeenCalledWith(anyDay);
    expect(mockReal.getSuggestion).toHaveBeenCalledWith('id-1');
  });

  it('실데이터 모드면 제안 쓰기 네 개도 real.ts로 — 가짜 제안 상태는 그대로', async () => {
    mockIsMock = false;
    mockReal.applySuggestion.mockResolvedValue();
    mockReal.undoSuggestion.mockResolvedValue();
    mockReal.ignoreSuggestion.mockResolvedValue();
    mockReal.reopenSuggestion.mockResolvedValue();
    await applySuggestion('id-1', 10);
    await undoSuggestion('id-1');
    await ignoreSuggestion('id-1');
    await reopenSuggestion('id-1');
    expect(mockReal.applySuggestion).toHaveBeenCalledWith('id-1', 10);
    expect(mockReal.undoSuggestion).toHaveBeenCalledWith('id-1');
    expect(mockReal.ignoreSuggestion).toHaveBeenCalledWith('id-1');
    expect(mockReal.reopenSuggestion).toHaveBeenCalledWith('id-1');
    expect(db.suggestion.status).toBe('PENDING');
  });

  it('실데이터 읽기 · 쓰기 실패는 가짜로 바꾸지 않고 그대로 던짐 (화면이 LoadError · 토스트로 보여 줌)', async () => {
    mockIsMock = false;
    mockReal.getMonth.mockRejectedValue(new Error('network'));
    mockReal.applySuggestion.mockRejectedValue(new Error('rls'));
    await expect(getMonth(2026, 10)).rejects.toThrow('network');
    await expect(applySuggestion('id-1', 10)).rejects.toThrow('rls');
  });

  it('실데이터 모드의 오늘은 real.ts가 정함, 가짜 모드는 목업의 5월 22일', () => {
    mockIsMock = false;
    mockReal.recordToday.mockReturnValue(new Date('2026-10-18T15:00:00Z'));
    expect(recordToday().toISOString()).toBe('2026-10-18T15:00:00.000Z');
    mockIsMock = true;
    expect(recordToday().getTime()).toBe(kst(22, 0).getTime());
  });

  it('가짜 모드면 real.ts를 부르지 않고 목업에서 읽음', async () => {
    const month = await getMonth(2025, 5);
    await getWeek(kst(22, 0));
    await getDay(kst(21, 0));
    await getPendingSuggestion();
    await getSuggestion('s1');
    expect(month.days).toHaveLength(31);
    for (const fn of Object.values(mockReal)) expect(fn).not.toHaveBeenCalled();
  });
});
