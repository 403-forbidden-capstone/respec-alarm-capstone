import { describe, expect, it } from '@jest/globals';

import { sampleSnapshot } from '../sample';

describe('sampleSnapshot — 웹 미리보기 샘플 권한 상태', () => {
  it('none은 샘플이 없음 (진짜 읽기로 넘어감)', () => {
    expect(sampleSnapshot('none')).toBeNull();
  });

  it('모두 켜짐', () => {
    expect(sampleSnapshot('allOn')).toEqual({
      supported: true,
      notifications: 'on',
      notificationsAsked: false,
      fullScreen: 'on',
      exactAlarm: 'on',
      usageAccess: 'on',
    });
  });

  it('알림 꺼짐은 물어본 적이 있어 홈 빨간 줄이 바로 보임', () => {
    expect(sampleSnapshot('notifyOff')).toMatchObject({ notifications: 'off', notificationsAsked: true, fullScreen: 'on' });
  });

  it('전체화면 꺼짐은 알림은 켜짐', () => {
    expect(sampleSnapshot('fullScreenOff')).toMatchObject({ notifications: 'on', fullScreen: 'off' });
  });
});
