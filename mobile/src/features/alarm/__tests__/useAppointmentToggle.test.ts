import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { toggleAppointment } from '../hooks/useAppointmentToggle';
import type { Appointment } from '../types';

// 카드 스위치의 저장 동작 (부품에서 훅으로 옮긴 것) — 확인창 · 토스트 · api는 가짜로
const mockConfirm = jest.fn<(opts: { title: string }) => Promise<boolean>>();
const mockToast = jest.fn<(text: string) => void>();
const mockSetEnabled = jest.fn<(id: string, enabled: boolean) => Promise<void>>();
jest.mock('@/components/ui', () => ({
  confirm: (opts: { title: string }) => mockConfirm(opts),
  toast: (text: string) => mockToast(text),
}));
jest.mock('../api', () => ({ setAppointmentEnabled: (id: string, enabled: boolean) => mockSetEnabled(id, enabled) }));
jest.mock('@/lib/useAction', () => ({ useAction: jest.fn() }));

// useAction의 run처럼: 실패하면 토스트로 넘기고 던지지 않음
const run = async (task: () => Promise<void>, fallback?: string) => {
  try {
    await task();
  } catch {
    mockToast(fallback ?? '');
  }
};

const appointment = (groupName?: string) => ({ id: 'a1', title: '팀 주간회의', groupName }) as Appointment;

beforeEach(() => {
  mockConfirm.mockReset();
  mockToast.mockReset();
  mockSetEnabled.mockReset().mockResolvedValue(undefined);
});

describe('toggleAppointment', () => {
  it('켜기 — 확인 없이 저장하고 다시 읽음', async () => {
    const onChanged = jest.fn();
    await toggleAppointment(appointment(), true, run, onChanged);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith('a1', true);
    expect(mockToast).toHaveBeenCalledWith('이 일정의 알람을 켰어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('공유 일정 끄기 — 확인창에서 취소하면 저장 · 다시 읽기 없음', async () => {
    mockConfirm.mockResolvedValue(false);
    const onChanged = jest.fn();
    await toggleAppointment(appointment('캡스톤팀'), false, run, onChanged);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSetEnabled).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('공유 일정 끄기 — 확인하면 끔', async () => {
    mockConfirm.mockResolvedValue(true);
    const onChanged = jest.fn();
    await toggleAppointment(appointment('캡스톤팀'), false, run, onChanged);
    expect(mockSetEnabled).toHaveBeenCalledWith('a1', false);
    expect(mockToast).toHaveBeenCalledWith('이 일정의 알람을 껐어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('저장에 실패해도 다시 읽어 스위치를 실제 상태로 돌림', async () => {
    mockSetEnabled.mockRejectedValue(new Error('network'));
    const onChanged = jest.fn();
    await toggleAppointment(appointment(), true, run, onChanged);
    expect(mockToast).toHaveBeenCalledWith('알람을 켜고 끄지 못했어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
