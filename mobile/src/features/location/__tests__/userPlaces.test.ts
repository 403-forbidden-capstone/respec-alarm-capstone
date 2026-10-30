import { describe, expect, it } from '@jest/globals';

import { UserError } from '@/lib/errors';

import {
  cleanLabel,
  fromRow,
  inputFromPick,
  LIMIT_MESSAGE,
  normalizeInput,
  placeError,
  toRow,
  unusedLabels,
  wouldExceedLimit,
  type UserPlace,
} from '../userPlaces';

const place = (label: string, extra: Partial<UserPlace> = {}): UserPlace => ({ label, name: `${label} 정문`, lat: 37.55, lng: 127.07, ...extra });
const five = ['학교', '회사', '알바', '도서관', '동아리방'].map((l) => place(l));

describe('cleanLabel', () => {
  it('앞뒤 공백을 빼고 안쪽 공백은 하나로, 20자까지만', () => {
    expect(cleanLabel('  학교   정문  ')).toBe('학교 정문');
    expect(cleanLabel('가'.repeat(25))).toBe('가'.repeat(20));
    expect(cleanLabel('   ')).toBe('');
  });
});

describe('normalizeInput', () => {
  it('이름표 · 이름을 다듬고 반경은 100~500으로 맞춤', () => {
    expect(normalizeInput({ label: ' 학교 ', name: ' 정문 ', address: ' 서울 1 ', lat: 37.5, lng: 127, radiusM: 80 })).toEqual({
      label: '학교',
      name: '정문',
      address: '서울 1',
      lat: 37.5,
      lng: 127,
      radiusM: 100,
    });
    expect(normalizeInput(place('회사', { radiusM: 900 })).radiusM).toBe(500);
    expect(normalizeInput(place('회사', { radiusM: 149.6 })).radiusM).toBe(150);
    expect('radiusM' in normalizeInput(place('회사'))).toBe(false);
  });

  it('이름표 · 장소 이름이 비었거나 좌표가 범위 밖이면 UserError', () => {
    for (const bad of [place('  '), place('학교', { name: '  ' }), place('학교', { lat: 91 }), place('학교', { lng: -181 }), place('학교', { lat: NaN })]) {
      expect(() => normalizeInput(bad)).toThrow(UserError);
    }
  });

  it('경계 좌표(±90, ±180)는 통과', () => {
    expect(normalizeInput(place('끝', { lat: -90, lng: 180 })).lat).toBe(-90);
  });
});

describe('행 변환', () => {
  it('numeric이 글자로 와도 숫자로, 빈 주소 · 반경 null은 칸을 빼서 화면 모양으로', () => {
    expect(fromRow({ label: '학교', name: '정문', address: null, lat: '37.550900', lng: '127.073600', radius_m: null })).toEqual({
      label: '학교',
      name: '정문',
      lat: 37.5509,
      lng: 127.0736,
    });
    expect(fromRow({ label: '회사', name: '역', address: '서울', lat: 37.5, lng: 127, radius_m: 300 })).toEqual({
      label: '회사',
      name: '역',
      address: '서울',
      lat: 37.5,
      lng: 127,
      radiusM: 300,
    });
  });

  it('저장 행은 없는 주소 · 반경도 null로 늘 보냄 (덮어쓸 때 옛 값이 남지 않게)', () => {
    expect(toRow('u1', { label: '학교', name: '정문', lat: 1, lng: 2 })).toEqual({
      user_id: 'u1',
      label: '학교',
      name: '정문',
      address: null,
      lat: 1,
      lng: 2,
      radius_m: null,
    });
  });
});

describe('한도 · 이름 칩', () => {
  it('5개일 때 새 이름표만 한도를 넘김 — 있는 이름표를 덮어쓰는 것은 통과', () => {
    expect(wouldExceedLimit(five, '여섯째')).toBe(true);
    expect(wouldExceedLimit(five, ' 학교 ')).toBe(false);
    expect(wouldExceedLimit(five.slice(0, 4), '여섯째')).toBe(false);
  });

  it('이름 칩은 학교 · 회사 · 알바 중 안 쓴 것', () => {
    expect(unusedLabels([])).toEqual(['학교', '회사', '알바']);
    expect(unusedLabels([place('회사'), place('도서관')])).toEqual(['학교', '알바']);
    expect(unusedLabels(five)).toEqual([]);
  });
});

describe('inputFromPick', () => {
  const picked = { name: '학교', address: '서울 광진구 능동로 209', lat: 37.55, lng: 127.07 };

  it('시트의 이름이 이름표, 장소 이름은 주소', () => {
    expect(inputFromPick(picked)).toEqual({ label: '학교', name: '서울 광진구 능동로 209', address: '서울 광진구 능동로 209', lat: 37.55, lng: 127.07 });
  });

  it('주소가 없으면 시트가 준 이름이 장소 이름도 됨', () => {
    expect(inputFromPick({ name: '지정한 위치', lat: 1, lng: 2 })).toEqual({ label: '지정한 위치', name: '지정한 위치', lat: 1, lng: 2 });
  });

  it('바꾸기는 이름표를 그대로 두고 위치만 바꿈, 반경은 전달', () => {
    expect(inputFromPick({ ...picked, name: '엉뚱한 이름', radiusM: 200 }, '회사')).toMatchObject({ label: '회사', radiusM: 200 });
  });

  it('좌표가 없는 장소는 null', () => {
    expect(inputFromPick({ name: '어딘가', address: '서울' })).toBeNull();
  });
});

describe('placeError', () => {
  it('5개 제한 트리거(54000)만 이유 문구, 나머지는 원래 오류 그대로', () => {
    const limit = placeError({ code: '54000' });
    expect(limit).toBeInstanceOf(UserError);
    expect((limit as Error).message).toBe(LIMIT_MESSAGE);
    const other = { code: '23514' };
    expect(placeError(other)).toBe(other);
  });
});
