// 이동시간 폴백 계산 — 7장 7.1.2
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateTravelMinutes, haversineKm, medianSameRoute, type TravelSample } from './travel.ts';

const SEOUL_STATION = { lat: 37.5547, lng: 126.9707 };
const GANGNAM_STATION = { lat: 37.4979, lng: 127.0276 };

test('haversine: 서울역 ↔ 강남역 약 8.1km', () => {
  const km = haversineKm(SEOUL_STATION, GANGNAM_STATION);
  assert.ok(km > 7.9 && km < 8.3, String(km));
  assert.equal(haversineKm(SEOUL_STATION, SEOUL_STATION), 0);
});

test('근사식: 거리 ÷ 속도 × 60 × 1.3 (도보 4 · 대중교통 22 · 자차 30 km/h)', () => {
  const km = haversineKm(SEOUL_STATION, GANGNAM_STATION);
  assert.equal(estimateTravelMinutes(SEOUL_STATION, GANGNAM_STATION, 'TRANSIT'), Math.round((km / 22) * 60 * 1.3));
  assert.equal(estimateTravelMinutes(SEOUL_STATION, GANGNAM_STATION, 'CAR'), Math.round((km / 30) * 60 * 1.3));
  assert.equal(estimateTravelMinutes(SEOUL_STATION, GANGNAM_STATION, 'WALK'), Math.round((km / 4) * 60 * 1.3));
  assert.equal(estimateTravelMinutes(SEOUL_STATION, GANGNAM_STATION, 'SUBWAY'), estimateTravelMinutes(SEOUL_STATION, GANGNAM_STATION, 'BUS'));
  assert.equal(estimateTravelMinutes(SEOUL_STATION, SEOUL_STATION, 'WALK'), 1); // 최소 1분
});

const sample = (minutes: number, over: Partial<TravelSample> = {}): TravelSample => ({
  origin: SEOUL_STATION,
  destination: GANGNAM_STATION,
  transport: 'TRANSIT',
  departedAt: new Date('2026-10-01T00:00:00Z'),
  arrivedAt: new Date(new Date('2026-10-01T00:00:00Z').getTime() + minutes * 60_000),
  ...over,
});

test('같은 경로 실측 3건 이상이면 중앙값', () => {
  const r = medianSameRoute([sample(40), sample(50), sample(45)], SEOUL_STATION, GANGNAM_STATION, 'TRANSIT');
  assert.deepEqual(r, { minutes: 45, sampleCount: 3 });
  // 짝수 건이면 가운데 둘의 평균
  assert.equal(medianSameRoute([sample(40), sample(50), sample(45), sample(60)], SEOUL_STATION, GANGNAM_STATION, 'TRANSIT')?.minutes, 48);
});

test('3건 미만이면 null', () => {
  assert.equal(medianSameRoute([sample(40), sample(50)], SEOUL_STATION, GANGNAM_STATION, 'TRANSIT'), null);
});

test('이동 수단이 다르거나 300m 밖이면 세지 않음', () => {
  const far = { lat: SEOUL_STATION.lat + 0.01, lng: SEOUL_STATION.lng }; // 약 1.1km
  const list = [sample(40), sample(50), sample(45, { transport: 'CAR' }), sample(30, { origin: far })];
  assert.equal(medianSameRoute(list, SEOUL_STATION, GANGNAM_STATION, 'TRANSIT'), null);
  assert.equal(medianSameRoute([...list, sample(60)], SEOUL_STATION, GANGNAM_STATION, 'TRANSIT')?.sampleCount, 3);
});

test('기록 오류(1분 미만 · 5시간 초과)는 뺌', () => {
  const list = [sample(0), sample(400), sample(40), sample(50)];
  assert.equal(medianSameRoute(list, SEOUL_STATION, GANGNAM_STATION, 'TRANSIT'), null);
});
