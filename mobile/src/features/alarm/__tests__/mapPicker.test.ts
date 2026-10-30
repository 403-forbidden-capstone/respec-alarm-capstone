import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_CENTER,
  isSamePin,
  mapPickerUrl,
  moveToMessage,
  namingPick,
  parsePageMessage,
  placeFromPin,
  resolveOrigin,
  setRadiusMessage,
  showsAreaWarning,
  UNNAMED_PLACE,
} from '../mapPicker';

const CAMPUS = { name: '세종대학교', address: '서울 광진구 능동로 209', category: '교육,학문 > 대학교', lat: 37.5509, lng: 127.0734 };
const BUILDING = { name: '세종대학교 광개토관', category: '교육,학문 > 대학교', lat: 37.5502, lng: 127.0742 };

describe('resolveOrigin', () => {
  it('환경변수 → 웹이면 지금 주소의 origin → 운영 주소 순', () => {
    expect(resolveOrigin('http://192.168.0.5:8081/', 'https://x.example')).toBe('http://192.168.0.5:8081'); // 끝 / 뺌
    expect(resolveOrigin(undefined, 'https://x.example')).toBe('https://x.example');
    expect(resolveOrigin('  ', undefined)).toBe('https://respec-alarm-capstone.vmgfh878.workers.dev');
  });
});

describe('mapPickerUrl', () => {
  it('키 · 처음 중심을 인자로 실음 (키는 주소용으로 인코딩, 좌표는 소수 6자리)', () => {
    expect(mapPickerUrl({ origin: 'https://a.example/', key: 'k e&y', center: { lat: 37.5665123456789, lng: 126.978 } })).toBe(
      'https://a.example/map-picker.html?key=k%20e%26y&lat=37.566512&lng=126.978',
    );
  });

  it('기본 중심은 서울 시청', () => {
    expect(DEFAULT_CENTER).toEqual({ lat: 37.5665, lng: 126.978 });
  });
});

describe('parsePageMessage', () => {
  it('JSON 글자도 이미 풀린 객체도 읽음', () => {
    expect(parsePageMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parsePageMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parsePageMessage(JSON.stringify({ type: 'center', lat: 37.5, lng: 127.1 }))).toEqual({ type: 'center', lat: 37.5, lng: 127.1 });
    expect(parsePageMessage('{"type":"error","reason":"no-key"}')).toEqual({ type: 'error', reason: 'no-key' });
    expect(parsePageMessage('{"type":"error","reason":"sdk-failed"}')).toEqual({ type: 'error', reason: 'sdk-failed' });
  });

  it('0도 좌표로 읽고, 필요한 칸만 걸러 냄 (여분 칸은 버림)', () => {
    expect(parsePageMessage({ type: 'center', lat: 0, lng: 0, extra: 1 })).toEqual({ type: 'center', lat: 0, lng: 0 });
  });

  it('깨졌거나 모르는 메시지는 null', () => {
    for (const raw of ['', 'not json', '{"type":', 'null', '3', '"ready"', null, undefined, 5, [], {}, { type: 'unknown' }, { type: 'center' }]) {
      expect(parsePageMessage(raw)).toBeNull();
    }
  });

  it('좌표가 숫자가 아니거나 범위 밖이면 null, 모르는 오류 이유도 null', () => {
    expect(parsePageMessage({ type: 'center', lat: '37.5', lng: 127 })).toBeNull();
    expect(parsePageMessage({ type: 'center', lat: Number.NaN, lng: 127 })).toBeNull();
    expect(parsePageMessage('{"type":"center","lat":91,"lng":127}')).toBeNull();
    expect(parsePageMessage({ type: 'center', lat: 37, lng: 181 })).toBeNull();
    expect(parsePageMessage({ type: 'error', reason: 'boom' })).toBeNull();
    expect(parsePageMessage({ type: 'error' })).toBeNull();
  });
});

describe('앱 → 페이지 메시지', () => {
  it('moveTo · setRadius는 JSON 글자', () => {
    expect(JSON.parse(moveToMessage(37.5, 127.1)!)).toEqual({ type: 'moveTo', lat: 37.5, lng: 127.1 });
    expect(JSON.parse(setRadiusMessage(150))).toEqual({ type: 'setRadius', meters: 150 });
  });

  it('범위 밖 좌표는 보내지 않고, 반경이 0 이하 · 숫자가 아니면 0(원 지움)', () => {
    expect(moveToMessage(91, 127)).toBeNull();
    expect(moveToMessage(37, Number.NaN)).toBeNull();
    expect(JSON.parse(setRadiusMessage(-5))).toEqual({ type: 'setRadius', meters: 0 });
    expect(JSON.parse(setRadiusMessage(Number.NaN))).toEqual({ type: 'setRadius', meters: 0 });
  });
});

describe('placeFromPin', () => {
  const point = { lat: 37.55, lng: 127.07 };

  it('이름: 직접 쓴 것 → 검색 결과 이름 → 건물 이름 → 주소 → 기본 글자', () => {
    const pinAddress = { address: '서울 광진구 능동로 209', name: '광개토관' };
    expect(placeFromPin({ point, typedName: ' 집 ', picked: CAMPUS, pinAddress }).name).toBe('집');
    expect(placeFromPin({ point, typedName: '', picked: CAMPUS, pinAddress }).name).toBe('세종대학교');
    expect(placeFromPin({ point, typedName: '', picked: null, pinAddress }).name).toBe('광개토관');
    expect(placeFromPin({ point, typedName: '', picked: null, pinAddress: { address: '서울 광진구 능동로 209' } }).name).toBe('서울 광진구 능동로 209');
    expect(placeFromPin({ point, typedName: '  ', picked: null, pinAddress: null }).name).toBe(UNNAMED_PLACE);
  });

  it('주소는 핀 자리 주소 우선, 없으면 검색 결과 주소, 둘 다 없으면 칸 없음 — 좌표는 핀 자리', () => {
    expect(placeFromPin({ point, typedName: '', picked: CAMPUS, pinAddress: { address: '핀 주소' } })).toEqual({ name: '세종대학교', address: '핀 주소', ...point });
    expect(placeFromPin({ point, typedName: '', picked: CAMPUS, pinAddress: null })).toEqual({ name: '세종대학교', address: CAMPUS.address, ...point });
    expect(placeFromPin({ point, typedName: '집', picked: null, pinAddress: null })).toEqual({ name: '집', ...point });
  });
});

describe('핀과 검색 결과', () => {
  it('isSamePin: 5m 안이면 같은 자리', () => {
    expect(isSamePin(CAMPUS, { lat: CAMPUS.lat + 0.00002, lng: CAMPUS.lng })).toBe(true); // 약 2m
    expect(isSamePin(CAMPUS, { lat: CAMPUS.lat + 0.0001, lng: CAMPUS.lng })).toBe(false); // 약 11m
  });

  it('showsAreaWarning: 캠퍼스 대표 위치를 골랐고 핀이 그대로일 때만, 핀을 움직이면 사라짐', () => {
    expect(showsAreaWarning(CAMPUS, { lat: CAMPUS.lat, lng: CAMPUS.lng })).toBe(true);
    expect(showsAreaWarning(CAMPUS, { lat: CAMPUS.lat + 0.001, lng: CAMPUS.lng })).toBe(false);
    expect(showsAreaWarning(BUILDING, { lat: BUILDING.lat, lng: BUILDING.lng })).toBe(false); // 건물은 경고 없음
    expect(showsAreaWarning(null, { lat: 1, lng: 2 })).toBe(false);
    expect(showsAreaWarning(CAMPUS, null)).toBe(false);
    expect(showsAreaWarning({ name: '좌표 없는 곳' }, { lat: 1, lng: 2 })).toBe(false);
  });

  it('namingPick: 핀이 검색 결과 100m 안일 때만 그 이름을 빌려 줌', () => {
    expect(namingPick(BUILDING, { lat: BUILDING.lat + 0.0003, lng: BUILDING.lng })).toBe(BUILDING); // 약 33m
    expect(namingPick(BUILDING, { lat: BUILDING.lat + 0.002, lng: BUILDING.lng })).toBeNull(); // 약 220m
    expect(namingPick(null, { lat: 1, lng: 2 })).toBeNull();
    expect(namingPick({ name: '좌표 없는 곳' }, { lat: 1, lng: 2 })).toBeNull();
    expect(namingPick(BUILDING, null)).toBeNull();
  });
});
