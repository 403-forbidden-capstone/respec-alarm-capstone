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

const appointment = (id: string, groupName?: string) => ({ id, title: id === 'a1' ? '팀 주간회의' : '저녁약속', groupName }) as Appointment;

beforeEach(() => {
  mockConfirm.mockReset();
  mockToast.mockReset();
  mockSetEnabled.mockReset().mockResolvedValue(undefined);
});

describe('toggleAppointment', () => {
  it('켜기 — 확인 없이 저장하고 다시 읽음', async () => {
    const onChanged = jest.fn();
    await toggleAppointment(appointment('a2'), true, new Set(), onChanged);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith('a2', true);
    expect(mockToast).toHaveBeenCalledWith('이 일정의 알람을 켰어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('공유 일정 켜기 — 켤 때는 확인창 없음', async () => {
    await toggleAppointment(appointment('a1', '캡스톤팀'), true, new Set(), jest.fn());
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith('a1', true);
  });

  it('공유 일정 끄기 — 확인창에서 취소하면 저장 · 다시 읽기 없음', async () => {
    mockConfirm.mockResolvedValue(false);
    const onChanged = jest.fn();
    await toggleAppointment(appointment('a1', '캡스톤팀'), false, new Set(), onChanged);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSetEnabled).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('공유 일정 끄기 — 확인하면 끔', async () => {
    mockConfirm.mockResolvedValue(true);
    const onChanged = jest.fn();
    await toggleAppointment(appointment('a1', '캡스톤팀'), false, new Set(), onChanged);
    expect(mockSetEnabled).toHaveBeenCalledWith('a1', false);
    expect(mockToast).toHaveBeenCalledWith('이 일정의 알람을 껐어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('저장에 실패해도 다시 읽어 스위치를 실제 상태로 돌림', async () => {
    mockSetEnabled.mockRejectedValue(new Error('network'));
    const onChanged = jest.fn();
    await toggleAppointment(appointment('a2'), true, new Set(), onChanged);
    expect(mockToast).toHaveBeenCalledWith('알람을 켜고 끄지 못했어요');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('같은 카드를 저장 중에 또 누르면 저장은 한 번, 다시 읽기는 둘 다', async () => {
    let finish!: () => void;
    mockSetEnabled.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const saving = new Set<string>();
    const onChanged = jest.fn();
    const first = toggleAppointment(appointment('a2'), false, saving, onChanged);
    await toggleAppointment(appointment('a2'), false, saving, onChanged);
    finish();
    await first;
    expect(mockSetEnabled).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(saving.size).toBe(0);
  });

  it('다른 카드는 저장 중에도 따로 저장됨', async () => {
    let finish!: () => void;
    mockSetEnabled.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const saving = new Set<string>();
    const first = toggleAppointment(appointment('a2'), false, saving, jest.fn());
    await toggleAppointment(appointment('a3'), false, saving, jest.fn());
    finish();
    await first;
    expect(mockSetEnabled.mock.calls).toEqual([
      ['a2', false],
      ['a3', false],
    ]);
  });
});
