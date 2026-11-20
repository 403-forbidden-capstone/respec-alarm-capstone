import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import { handlePushTask, PUSH_TASK, pushDataOf, registerPushTask } from '../backgroundTask';

// 조용한 데이터 푸시 → 백그라운드 작업 (G2). 바깥(맞추기 · 로그인 · 모드 · 네이티브 모듈)만 가짜 — 시나리오 시험(__scenarios__/appointment.test.ts)이 실제 맞추기까지 함께 봄
const mockSync = jest.fn<() => Promise<void>>();
const mockUser = jest.fn<() => Promise<string | null>>();
const mockIsMock = jest.fn<() => boolean>();
const mockRegister = jest.fn<(name: string) => Promise<void>>();
jest.mock('@/lib/alarmSync', () => ({ syncNow: () => mockSync() }));
jest.mock('@/lib/user', () => ({ currentUserId: () => mockUser() }));
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock() }));
jest.mock('@/features/location/native', () => ({
  nativeNotifications: () => ({ registerTaskAsync: (name: string) => mockRegister(name) }),
  nativeTasks: () => ({ defineTask: () => {} }),
  errorText: (e: unknown) => String(e),
}));

const ME = 'user-me';
const silent = (over: Record<string, unknown> = {}) => ({ kind: 'GROUP_APPT_CHANGED', change: 'CHANGED', needsConfirm: false, silent: true, recipientUserId: ME, appointmentId: 'a1', groupId: 'g1', path: '/group', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // 실패 경로 시험이 개발 경고를 찍음
  mockSync.mockResolvedValue(undefined);
  mockUser.mockResolvedValue(ME);
  mockIsMock.mockReturnValue(false);
  mockRegister.mockResolvedValue(undefined);
});

describe('pushDataOf — 작업 body 모양이 달라도 푸시 data를 찾음', () => {
  const data = silent();
  it('data가 바로 객체 · 중첩 data · notification 안 · JSON 글자(dataString) · Expo가 감싼 body 글자', () => {
    expect(pushDataOf(data)).toEqual(data);
    expect(pushDataOf({ data })).toEqual(data);
    expect(pushDataOf({ notification: { request: { content: { data } } } })).toEqual(data);
    expect(pushDataOf({ dataString: JSON.stringify(data) })).toEqual(data);
    expect(pushDataOf({ dataString: JSON.stringify({ experienceId: '@x/y', body: JSON.stringify(data) }) })).toEqual(data);
  });
  it('서버 푸시가 아니거나(kind 없음 · 모르는 kind) 글자가 깨졌거나 너무 깊으면 null', () => {
    expect(pushDataOf(null)).toBeNull();
    expect(pushDataOf('text')).toBeNull();
    expect(pushDataOf({ dataString: '{깨짐' })).toBeNull();
    expect(pushDataOf({ kind: 'SOMETHING_NEW' })).toBeNull();
    expect(pushDataOf({ a: { b: { c: { d: { e: { f: { g: data } } } } } } })).toBeNull();
  });
});

describe('handlePushTask — 알람을 다시 맞출 때만 syncNow', () => {
  it('내 계정으로 온 조용한 약속 변경 · 취소 푸시면 맞춤', async () => {
    await handlePushTask({ data: { dataString: JSON.stringify(silent()) } });
    expect(mockSync).toHaveBeenCalledTimes(1);
    mockSync.mockClear();
    await handlePushTask({ data: silent({ change: 'CANCELED' }) });
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it('받는 사람이 다른 계정 · 로그인 안 됨 · 확인이 필요한 변경(needsConfirm) · 알람에 닿지 않는 종류면 안 맞춤', async () => {
    await handlePushTask({ data: silent({ recipientUserId: 'other' }) });
    mockUser.mockResolvedValueOnce(null);
    await handlePushTask({ data: silent() });
    await handlePushTask({ data: silent({ needsConfirm: true }) });
    await handlePushTask({ data: silent({ kind: 'GROUP_MEMBER_JOINED', change: undefined }) });
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('보이는 알림(silent 아님)은 앱이 앞 · 뒤에 있을 때 받음 리스너가 맡으므로 여기서는 안 맞춤, 오류 · 가짜 모드 · 빈 body도 안 함', async () => {
    await handlePushTask({ data: silent({ silent: undefined }) });
    await handlePushTask({ data: silent(), error: { message: 'x' } });
    await handlePushTask(undefined);
    mockIsMock.mockReturnValue(true);
    await handlePushTask({ data: silent() });
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('맞추기가 던져도 작업은 던지지 않음 (expo-task-manager가 끝난 것으로 보게)', async () => {
    mockSync.mockRejectedValueOnce(new Error('network'));
    await expect(handlePushTask({ data: silent() })).resolves.toBeUndefined();
  });
});

describe('registerPushTask — 앱을 열 때마다 작업 등록', () => {
  it('안드로이드에서는 작업 이름으로 등록, 다른 플랫폼은 안 함, 등록이 실패해도 던지지 않고 false', async () => {
    expect(await registerPushTask()).toBe(false); // jest 기본 플랫폼 = ios
    expect(mockRegister).not.toHaveBeenCalled();
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(await registerPushTask()).toBe(true);
    expect(mockRegister).toHaveBeenCalledWith(PUSH_TASK);
    mockRegister.mockRejectedValueOnce(new Error('no native'));
    expect(await registerPushTask()).toBe(false);
    jest.restoreAllMocks();
  });
});
