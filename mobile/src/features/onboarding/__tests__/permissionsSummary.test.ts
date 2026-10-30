import { describe, expect, it } from '@jest/globals';

import { permissionStateLabel, permissionsSummary } from '../permissionsSummary';

describe('권한 안내 요약', () => {
  it('줄이 없으면 빈 글자(요약을 그리지 않음)', () => {
    expect(permissionsSummary([])).toBe('');
  });

  it('모두 허용이면 모두 켜져 있어요', () => {
    expect(permissionsSummary([{ state: 'ok' }, { state: 'ok' }])).toBe('모두 켜져 있어요');
  });

  it('꺼짐 · 확인 전을 합쳐 센다', () => {
    expect(permissionsSummary([{ state: 'ok' }, { state: 'off' }, { state: 'unknown' }])).toBe('2개를 켜면 알람이 더 확실해요');
    expect(permissionsSummary([{ state: 'unknown' }])).toBe('1개를 켜면 알람이 더 확실해요');
  });

  it('상태 글자', () => {
    expect(permissionStateLabel('ok')).toBe('허용');
    expect(permissionStateLabel('off')).toBe('꺼짐');
    expect(permissionStateLabel('unknown')).toBe('확인 전');
  });
});
