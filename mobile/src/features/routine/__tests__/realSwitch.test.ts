import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { aiDb } from '@/mocks/ai';
import { db } from '@/mocks/data';

import {
  advanceRoutine,
  declineRoutineSuggestion,
  editJournal,
  getEveningRoutine,
  getJournal,
  getRoutine,
  getTodayRoutine,
  listTodos,
  saveRoutine,
  toggleTodo,
} from '../api';
import type { Routine } from '../types';

// api.ts가 함수 맨 앞에서 실데이터(real.ts)와 가짜를 나누는지 — features/alarm/__tests__/realSwitch.test.ts와 같은 방식
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const mockReal = {
  getTodayRoutine: jest.fn<() => Promise<unknown>>(),
  advanceRoutine: jest.fn<(id: string) => Promise<unknown>>(),
  listTodos: jest.fn<(day: Date) => Promise<unknown>>(),
  toggleTodo: jest.fn<(id: string) => Promise<void>>(),
  getJournal: jest.fn<(date: string) => Promise<unknown>>(),
  editJournal: jest.fn<(date: string, text: string) => Promise<void>>(),
  declineRoutineSuggestion: jest.fn<(date: string) => Promise<void>>(),
  getEveningRoutine: jest.fn<() => Promise<unknown>>(),
  getRoutine: jest.fn<(id: string, journal?: string) => Promise<unknown>>(),
  saveRoutine: jest.fn<(routine: Routine) => Promise<unknown>>(),
};
jest.mock('../real', () => ({
  getTodayRoutine: () => mockReal.getTodayRoutine(),
  advanceRoutine: (id: string) => mockReal.advanceRoutine(id),
  listTodos: (day: Date) => mockReal.listTodos(day),
  toggleTodo: (id: string) => mockReal.toggleTodo(id),
  getJournal: (date: string) => mockReal.getJournal(date),
  editJournal: (date: string, text: string) => mockReal.editJournal(date, text),
  declineRoutineSuggestion: (date: string) => mockReal.declineRoutineSuggestion(date),
  getEveningRoutine: () => mockReal.getEveningRoutine(),
  getRoutine: (id: string, journal?: string) => mockReal.getRoutine(id, journal),
  saveRoutine: (routine: Routine) => mockReal.saveRoutine(routine),
}));

beforeEach(() => {
  mockIsMock = true;
  for (const fn of Object.values(mockReal)) fn.mockReset();
});

describe('routine/api.ts 가짜 · 실데이터 나누기', () => {
  it('실데이터 모드면 읽기를 real.ts로 넘기고 결과를 그대로 돌려줌', async () => {
    mockIsMock = false;
    mockReal.getTodayRoutine.mockResolvedValue('progress');
    mockReal.listTodos.mockResolvedValue(['todo']);
    mockReal.getJournal.mockResolvedValue('journal');
    mockReal.getEveningRoutine.mockResolvedValue(null);
    mockReal.getRoutine.mockResolvedValue('routine');
    const day = new Date('2026-10-19T00:00:00Z');
    await expect(getTodayRoutine()).resolves.toBe('progress');
    await expect(listTodos(day)).resolves.toEqual(['todo']);
    await expect(getJournal('2026-10-19')).resolves.toBe('journal');
    await expect(getEveningRoutine()).resolves.toBeNull();
    await expect(getRoutine('new', '2026-10-19')).resolves.toBe('routine');
    expect(mockReal.listTodos).toHaveBeenCalledWith(day);
    expect(mockReal.getRoutine).toHaveBeenCalledWith('new', '2026-10-19');
  });

  it('실데이터 모드면 쓰기도 real.ts로 — 가짜 루틴 · 일기 · 준비물은 그대로', async () => {
    mockIsMock = false;
    mockReal.advanceRoutine.mockResolvedValue('progress');
    mockReal.saveRoutine.mockResolvedValue('saved');
    mockReal.toggleTodo.mockResolvedValue();
    mockReal.editJournal.mockResolvedValue();
    mockReal.declineRoutineSuggestion.mockResolvedValue();
    const routine = { id: null } as Routine;
    const doneBefore = db.todos.map((t) => t.done);
    const routinesBefore = aiDb.routines.length;
    const doneStepsBefore = db.morningRoutine.done;
    await expect(advanceRoutine('r-1')).resolves.toBe('progress');
    await expect(saveRoutine(routine)).resolves.toBe('saved');
    await toggleTodo('t-1');
    await editJournal('2026-10-19', '글');
    await declineRoutineSuggestion('2026-10-19');
    expect(mockReal.advanceRoutine).toHaveBeenCalledWith('r-1');
    expect(mockReal.saveRoutine).toHaveBeenCalledWith(routine);
    expect(mockReal.toggleTodo).toHaveBeenCalledWith('t-1');
    expect(mockReal.editJournal).toHaveBeenCalledWith('2026-10-19', '글');
    expect(mockReal.declineRoutineSuggestion).toHaveBeenCalledWith('2026-10-19');
    expect(db.todos.map((t) => t.done)).toEqual(doneBefore);
    expect([aiDb.routines.length, db.morningRoutine.done]).toEqual([routinesBefore, doneStepsBefore]);
  });

  it('실데이터 읽기 · 쓰기 실패는 가짜로 바꾸지 않고 그대로 던짐', async () => {
    mockIsMock = false;
    mockReal.getTodayRoutine.mockRejectedValue(new Error('network'));
    mockReal.saveRoutine.mockRejectedValue(new Error('rls'));
    await expect(getTodayRoutine()).rejects.toThrow('network');
    await expect(saveRoutine({ id: null } as Routine)).rejects.toThrow('rls');
  });

  it('가짜 모드면 real.ts를 부르지 않고 목업에서 읽음', async () => {
    const progress = await getTodayRoutine();
    await listTodos(new Date('2025-05-21T15:00:00Z'));
    await getJournal('2025-05-21');
    await getEveningRoutine();
    await getRoutine('new');
    expect(progress?.title).toBe('차분한 출근 준비');
    for (const fn of Object.values(mockReal)) expect(fn).not.toHaveBeenCalled();
  });
});
