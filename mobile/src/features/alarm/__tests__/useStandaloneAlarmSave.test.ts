import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { saveStandaloneAlarm } from '../hooks/useStandaloneAlarmSave';
import type { NewStandaloneAlarm } from '../api';
import type { SaveFollowUp } from '../types';

// 기본 알람 저장 (#588) — 부품에서 훅으로 옮긴 것. 토스트 · 알림 권한 · api · 시계는 가짜로
const mockToast = jest.fn<(text: string) => void>();
const mockAsk = jest.fn<(reason: string) => Promise<void>>();
const mockCreate = jest.fn<(input: NewStandaloneAlarm) => Promise<{ id: string; followUp?: SaveFollowUp }>>();
let mockNow = new Date('2026-11-21T10:00:00+09:00'); // 토요일 오전 10시
jest.mock('@/components/ui', () => ({ toast: (text: string) => mockToast(text) }));
jest.mock('@/features/permissions', () => ({ askNotifications: (reason: string) => mockAsk(reason) }));
jest.mock('@/lib/clock', () => ({ now: () => mockNow }));
jest.mock('../api', () => ({ createStandaloneAlarm: (input: NewStandaloneAlarm) => mockCreate(input) }));

beforeEach(() => {
  mockNow = new Date('2026-11-21T10:00:00+09:00');
  mockToast.mockReset();
  mockAsk.mockReset().mockResolvedValue(undefined);
  mockCreate.mockReset().mockResolvedValue({ id: 's1' });
});

describe('saveStandaloneAlarm', () => {
  it('평일 오전 7시 — 저장 순간 기준 첫 회차(다음 월요일)로 저장하고 토스트 · 알림 권한 · 저장한 id', async () => {
    const onSaved = jest.fn();
    await saveStandaloneAlarm(7 * 60, ['월', '화', '수', '목', '금'], onSaved);
    expect(mockCreate).toHaveBeenCalledWith({ at: new Date('2026-11-23T07:00:00+09:00'), repeat: ['월', '화', '수', '목', '금'] });
    expect(mockToast).toHaveBeenCalledWith('알람을 만들었어요 · 11월 23일 (월) 오전 7:00');
    expect(mockAsk).toHaveBeenCalledWith('alarm');
    expect(onSaved).toHaveBeenCalledWith('s1');
  });

  it('반복 없음 — 오늘 남은 시각이면 오늘', async () => {
    await saveStandaloneAlarm(11 * 60, [], jest.fn());
    expect(mockCreate).toHaveBeenCalledWith({ at: new Date('2026-11-21T11:00:00+09:00'), repeat: [] });
    expect(mockToast).toHaveBeenCalledWith('알람을 만들었어요 · 오늘 · 11월 21일 (토) 오전 11:00');
  });

  it('폰에 못 걸었으면 저장은 됐다는 안내', async () => {
    mockCreate.mockResolvedValue({ id: 's2', followUp: { phoneFailed: 1, itemsFailed: false } });
    const onSaved = jest.fn();
    await saveStandaloneAlarm(11 * 60, [], onSaved);
    expect(mockToast).toHaveBeenCalledWith('알람은 저장했지만 알람 1개를 폰에 걸지 못했어요. 홈 안내를 확인해 주세요');
    expect(onSaved).toHaveBeenCalledWith('s2');
  });

  it('저장 실패 — 던지고 토스트 · 권한 · onSaved 없음 (토스트는 useAction이)', async () => {
    mockCreate.mockRejectedValue(new Error('network'));
    const onSaved = jest.fn();
    await expect(saveStandaloneAlarm(11 * 60, [], onSaved)).rejects.toThrow('network');
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockAsk).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
