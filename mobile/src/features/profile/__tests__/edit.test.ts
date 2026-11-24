import { describe, expect, it } from '@jest/globals';

import { canSaveHandle, canSaveNickname, isPrepareChanged, prepareValuesOf } from '../edit';

const base = { outingPrep: null, buffer: 10, transport: 'TRANSIT', margin: 'NORMAL' } as const;

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
  it('순수 준비시간 또는 다른 설정이 변경되면 바뀜', () => {
    expect(isPrepareChanged(base, { ...base })).toBe(false);
     expect(isPrepareChanged(base, { ...base, outingPrep: 30 })).toBe(true);
    expect(isPrepareChanged(base, { ...base, buffer: 15 })).toBe(true);
    expect(isPrepareChanged(base, { ...base, transport: 'CAR' })).toBe(true);
    expect(isPrepareChanged(base, { ...base, margin: 'LOOSE' })).toBe(true);
  });
});

describe('prepareValuesOf', () => {
  it('프로필 값을 그대로, 편집기 범위 밖이면 범위 안으로', () => {
    const profile = { default_prepare_minutes: 45, default_outing_prep_minutes: null, default_buffer_minutes: 10, default_transport: 'BUS', wake_margin: 'TIGHT' } as const;
    expect(prepareValuesOf(profile)).toEqual({ outingPrep: null, buffer: 10, transport: 'BUS', margin: 'TIGHT' });
    expect(prepareValuesOf({ ...profile, default_prepare_minutes: 2, default_buffer_minutes: 90 })).toMatchObject({ buffer: 60 });
    expect(prepareValuesOf({ ...profile, default_outing_prep_minutes: 35 })).toMatchObject({ outingPrep: 35 });
    // Legacy wake→departure must never be read back into the new form.
    expect(prepareValuesOf({ ...profile, default_prepare_minutes: 180 })).toEqual(prepareValuesOf(profile));
  });
});
