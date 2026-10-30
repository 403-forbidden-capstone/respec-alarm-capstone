import { describe, expect, it } from '@jest/globals';

import { canSaveHandle, canSaveNickname, homePatch, isPrepareChanged, prepareValuesOf } from '../edit';

const base = { prepare: 60, buffer: 10, transport: 'TRANSIT', margin: 'NORMAL' } as const;

describe('canSaveNickname', () => {
  it('바뀌었고 규칙에 맞을 때만', () => {
    expect(canSaveNickname('지형', '지형이')).toBe(true);
    expect(canSaveNickname('지형', '지형')).toBe(false);
    expect(canSaveNickname('지형', '  지형 ')).toBe(false); // 공백만 다름
    expect(canSaveNickname('지형', '   ')).toBe(false);
    expect(canSaveNickname('지형', '가'.repeat(31))).toBe(false);
  });
});

describe('canSaveHandle', () => {
  it('형식이 맞고 지금 아이디와 다를 때만', () => {
    expect(canSaveHandle('respec_kim', 'respec_lee')).toBe(true);
    expect(canSaveHandle('respec_kim', '@Respec_Kim')).toBe(false); // 같은 아이디
    expect(canSaveHandle('respec_kim', 'ab')).toBe(false);
    expect(canSaveHandle(null, 'respec_kim')).toBe(true);
  });
});

describe('isPrepareChanged', () => {
  it('네 칸 중 하나라도 다르면 바뀜', () => {
    expect(isPrepareChanged(base, { ...base })).toBe(false);
    expect(isPrepareChanged(base, { ...base, prepare: 65 })).toBe(true);
    expect(isPrepareChanged(base, { ...base, buffer: 15 })).toBe(true);
    expect(isPrepareChanged(base, { ...base, transport: 'CAR' })).toBe(true);
    expect(isPrepareChanged(base, { ...base, margin: 'LOOSE' })).toBe(true);
  });
});

describe('prepareValuesOf', () => {
  it('프로필 값을 그대로, 편집기 범위 밖이면 범위 안으로', () => {
    const profile = { default_prepare_minutes: 45, default_buffer_minutes: 10, default_transport: 'BUS', wake_margin: 'TIGHT' } as const;
    expect(prepareValuesOf(profile)).toEqual({ prepare: 45, buffer: 10, transport: 'BUS', margin: 'TIGHT' });
    expect(prepareValuesOf({ ...profile, default_prepare_minutes: 2, default_buffer_minutes: 90 })).toMatchObject({ prepare: 5, buffer: 60 });
  });
});

describe('homePatch', () => {
  it('좌표가 있는 장소는 이름과 좌표를 같이 돌려줌', () => {
    expect(homePatch({ name: '우리집', lat: 37.5, lng: 127.0 })).toEqual({ home_name: '우리집', home_lat: 37.5, home_lng: 127.0 });
  });

  it('좌표가 없거나 하나만 있으면 null — 집으로 못 정함 (0도 좌표로 침)', () => {
    expect(homePatch({ name: '최근 장소' })).toBeNull();
    expect(homePatch({ name: '반쪽', lat: 37.5 })).toBeNull();
    expect(homePatch({ name: '적도', lat: 0, lng: 0 })).not.toBeNull();
  });
});
