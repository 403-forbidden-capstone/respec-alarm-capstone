import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { onDetectionNotice } from '../notice';

// 감지 안내 알림 — expo-notifications는 가짜로 두고 부른 내용만 확인
let mockOS = 'android';
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    get OS() {
      return mockOS;
    },
    select: (o: Record<string, unknown>) => o[mockOS] ?? o.default,
  },
}));

const mockPermissions = jest.fn<() => Promise<{ granted: boolean }>>();
const mockSchedule = jest.fn<(request: Record<string, unknown>) => Promise<string>>();
const mockDismiss = jest.fn<(id: string) => Promise<void>>();
const mockCancel = jest.fn<(id: string) => Promise<void>>();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockPermissions(),
  scheduleNotificationAsync: (request: Record<string, unknown>) => mockSchedule(request),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  cancelScheduledNotificationAsync: (id: string) => mockCancel(id),
}));

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const settle = () => new Promise((resolve) => setImmediate(resolve)); // onDetectionNotice는 기다릴 수 없어서 일이 끝나길 한 턴 기다림

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // 실패 경로의 개발용 로그를 조용히
  mockOS = 'android';
  mockPermissions.mockReset();
  mockSchedule.mockReset();
  mockPermissions.mockResolvedValue({ granted: true });
  mockSchedule.mockResolvedValue('id');
  mockDismiss.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(undefined);
});

describe('감지 안내 알림 (onDetectionNotice)', () => {
  it('DEPART_PENDING: 소리 없는 즉시 알림 — 제목에 감지 시각, 누르면 정정 화면 주소', async () => {
    onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') });
    await settle();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith({
      identifier: `detect-DEPART-p1-${at('08:30')}`,
      content: {
        title: '출발 오전 8:30 감지',
        body: '아니면 눌러서 정정해요',
        data: { url: `respecalarm://detection?kind=DEPART&participantId=p1&at=${at('08:30')}` },
        sound: false,
      },
      trigger: { channelId: 'detect_v1' },
    });
  });

  it('ARRIVE: "도착 오후 … 감지" 알림 (종류 ARRIVE)', async () => {
    onDetectionNotice({ type: 'ARRIVE', participantId: 'p1', at: at('21:52') });
    await settle();
    const request = mockSchedule.mock.calls[0][0] as { identifier: string; content: { title: string; data: { url: string } } };
    expect(request.content.title).toBe('도착 오후 9:52 감지');
    expect(request.content.data.url).toContain('kind=ARRIVE');
    expect(request.identifier).toBe(`detect-ARRIVE-p1-${at('21:52')}`);
  });

  it('같은 판정이면 같은 알림 번호 (다시 띄워도 쌓이지 않음)', async () => {
    onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') });
    onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') });
    await settle();
    const ids = mockSchedule.mock.calls.map(([request]) => request.identifier);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('DEPART_CANCEL: 같은 번호의 알림을 거둠 (떠 있는 것 · 예약된 것 둘 다), 새로 띄우지 않음', async () => {
    onDetectionNotice({ type: 'DEPART_CANCEL', participantId: 'p1', at: at('08:30') });
    await settle();
    const id = `detect-DEPART-p1-${at('08:30')}`;
    expect(mockDismiss).toHaveBeenCalledWith(id);
    expect(mockCancel).toHaveBeenCalledWith(id);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('DEPART_CANCEL: 하나가 실패해도 다른 하나는 함', async () => {
    mockDismiss.mockRejectedValue(new Error('gone'));
    onDetectionNotice({ type: 'DEPART_CANCEL', participantId: 'p1', at: at('08:30') });
    await settle();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('알림 권한이 없으면 조용히 건너뜀 — 권한을 묻지 않음', async () => {
    mockPermissions.mockResolvedValue({ granted: false });
    onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') });
    await settle();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('서버에 쓰는 종류(DEPART)는 안내하지 않음 — 출발 안내는 DEPART_PENDING에서 이미 나감', async () => {
    onDetectionNotice({ type: 'DEPART', participantId: 'p1', at: at('08:30') });
    await settle();
    expect(mockPermissions).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it.each(['web', 'ios'])('%s: 아무것도 안 함', async (os) => {
    mockOS = os;
    onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') });
    onDetectionNotice({ type: 'DEPART_CANCEL', participantId: 'p1', at: at('08:30') });
    await settle();
    expect(mockPermissions).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('알림을 못 띄워도 던지지 않음 (예약 실패 · 권한 확인 실패)', async () => {
    mockSchedule.mockRejectedValue(new Error('native'));
    expect(() => onDetectionNotice({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:30') })).not.toThrow();
    mockPermissions.mockRejectedValue(new Error('native'));
    expect(() => onDetectionNotice({ type: 'ARRIVE', participantId: 'p1', at: at('09:00') })).not.toThrow();
    await settle();
  });
});
