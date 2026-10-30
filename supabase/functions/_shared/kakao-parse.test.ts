// 카카오 응답 읽기 · 호출 — 공식 문서(2026-10-15)의 응답 모양을 따른 샘플. 실제 응답과 맞는지는 키가 온 뒤 한 번 불러 확인할 것
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KakaoError, kakaoTravelMinutes, reverseAddress, searchPlaces, type FetchLike } from './kakao.ts';
import { parseCarDirections, parsePlaces, parseReverse, parseTransit, parseWalk } from './kakao-parse.ts';

const ORIGIN = { lat: 37.5547, lng: 126.9707 };
const DEST = { lat: 37.4979, lng: 127.0276 };

const transitJson = {
  status: 'OK',
  properties: { total: 2, bus: 1, subway: 1, busAndSubway: 0, landingURL: 'https://map.kakao.com/' },
  routes: [
    {
      properties: { type: 'BUS', totalDistance: 9000, totalTime: 2400, transfers: 0, fare: { value: 1500, min: 1500, max: 1500 } },
      steps: [
        { properties: { type: 'BUS', time: 2400, distance: 9000 }, path: { points: [[126.971, 37.555], [127.0, 37.52], [127.027, 37.498]] } },
      ],
    },
    {
      properties: { type: 'SUBWAY', totalDistance: 9500, totalTime: 1800, transfers: 1, fare: { value: 1500, min: 1500, max: 1500 } },
      steps: [
        { properties: { type: 'SUBWAY', time: 900, distance: 5000 }, path: { points: [[126.9726, 37.5559], [126.99, 37.53]] } },
        { properties: { type: 'WALKING', time: 120, distance: 100 }, path: { points: [[126.99, 37.53], [126.9905, 37.5302]] } },
        { properties: { type: 'SUBWAY', time: 780, distance: 4000 }, path: { points: [[126.9905, 37.5302], [127.0276, 37.4979]] } },
      ],
    },
  ],
};

test('장소 검색 응답: 도로명 주소 우선, 좌표는 숫자로, 모자란 항목은 뺌', () => {
  const places = parsePlaces({
    documents: [
      { id: '1', place_name: '세종대학교', address_name: '서울 광진구 능동 98', road_address_name: '서울 광진구 능동로 209', x: '127.0736', y: '37.5509', category_name: '교육 > 대학교' },
      { id: '2', place_name: '지번만', address_name: '서울 어딘가', road_address_name: '', x: '127.1', y: '37.5' },
      { id: '3', place_name: '좌표 없음', address_name: 'x' },
    ],
  });
  assert.deepEqual(places, [
    { id: '1', name: '세종대학교', address: '서울 광진구 능동로 209', lat: 37.5509, lng: 127.0736, category: '교육 > 대학교' },
    { id: '2', name: '지번만', address: '서울 어딘가', lat: 37.5, lng: 127.1 },
  ]);
  assert.deepEqual(parsePlaces(null), []);
});

test('대중교통 응답: 가장 빠른 경로, 버스만/지하철만 고를 수 있고 맞는 게 없으면 전체에서', () => {
  const any = parseTransit(transitJson);
  assert.ok(any.ok);
  assert.equal(any.seconds, 1800); // 지하철이 더 빠름
  assert.deepEqual([any.startsWithWalk, any.endsWithWalk], [false, false]);
  assert.deepEqual(any.firstPoint, { lat: 37.5559, lng: 126.9726 });
  assert.deepEqual(any.lastPoint, { lat: 37.4979, lng: 127.0276 });

  const bus = parseTransit(transitJson, 'BUS');
  assert.ok(bus.ok && bus.seconds === 2400);
  const onlyBus = { ...transitJson, routes: [transitJson.routes[0]] };
  const subway = parseTransit(onlyBus, 'SUBWAY');
  assert.ok(subway.ok && subway.seconds === 2400);
});

test('대중교통 응답: 첫 · 마지막 단계가 도보면 표시, 상태가 NO_RESULTS면 경로 없음', () => {
  const walky = {
    status: 'OK',
    routes: [
      {
        properties: { type: 'SUBWAY', totalTime: 1000 },
        steps: [
          { properties: { type: 'WALKING' }, path: { points: [[1, 2], [3, 4]] } },
          { properties: { type: 'SUBWAY' }, path: { points: [[3, 4], [5, 6]] } },
          { properties: { type: 'WALKING' }, path: { points: [[5, 6], [7, 8]] } },
        ],
      },
    ],
  };
  const r = parseTransit(walky);
  assert.ok(r.ok);
  assert.deepEqual([r.startsWithWalk, r.endsWithWalk], [true, true]);
  assert.deepEqual(parseTransit({ status: 'NO_RESULTS' }), { ok: false, reason: 'NO_ROUTE', detail: 'NO_RESULTS' });
  assert.deepEqual(parseTransit({ status: 'EQUAL_POINTS' }), { ok: true, seconds: 0, startsWithWalk: true, endsWithWalk: true });
  assert.deepEqual(parseTransit('x'), { ok: false, reason: 'BAD_RESPONSE' });
});

test('도보 · 자동차 응답', () => {
  assert.deepEqual(parseWalk({ status: 'OK', route: { properties: { totalDistance: 800, totalTime: 600 } } }), { ok: true, seconds: 600 });
  assert.deepEqual(parseWalk({ status: 'SAME_POINT' }), { ok: true, seconds: 0 });
  assert.deepEqual(parseWalk({ status: 'TOO_FAR_AWAY' }), { ok: false, reason: 'NO_ROUTE', detail: 'TOO_FAR_AWAY' });
  assert.deepEqual(parseCarDirections({ routes: [{ result_code: 0, summary: { distance: 3053, duration: 885 } }] }), { ok: true, seconds: 885 });
  assert.deepEqual(parseCarDirections({ routes: [{ result_code: 1, result_msg: '길찾기 결과를 찾을 수 없음' }] }), { ok: false, reason: 'NO_ROUTE', detail: 'result_code 1' });
  assert.deepEqual(parseCarDirections({}), { ok: false, reason: 'BAD_RESPONSE' });
});

// 주소별로 정해 둔 응답을 돌려주는 가짜 fetch
function fakeFetch(handlers: Record<string, () => Response | Promise<Response>>, calls: string[] = []): FetchLike {
  return async (input, init) => {
    calls.push(`${input}|${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`);
    const url = new URL(input);
    const handler = handlers[url.origin + url.pathname];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

test('대중교통: 대중교통 구간 + 빠진 앞뒤 도보를 도보 API로 더해 분 단위로 올림', async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(
    {
      'https://dapi.kakao.com/v2/routing/publictraffic': ok(transitJson),
      'https://dapi.kakao.com/v2/routing/walk': ok({ status: 'OK', route: { properties: { totalTime: 300 } } }), // 앞 5분 · 뒤 5분
    },
    calls,
  );
  const r = await kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'TRANSIT' }, fetchImpl);
  assert.deepEqual(r, { minutes: 40, partial: false }); // 1800 + 300 + 300 = 2400초
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.endsWith('|KakaoAK KEY')));
  assert.ok(calls[0].includes('start_x=126.9707') && calls[0].includes('end_y=37.4979'));
});

test('대중교통: 도보 API가 실패하면 대중교통 구간만 (partial)', async () => {
  const fetchImpl = fakeFetch({
    'https://dapi.kakao.com/v2/routing/publictraffic': ok(transitJson),
    'https://dapi.kakao.com/v2/routing/walk': () => new Response('x', { status: 500 }),
  });
  assert.deepEqual(await kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'TRANSIT' }, fetchImpl), { minutes: 30, partial: true });
});

test('도보 · 자동차는 각자 API 한 번', async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(
    {
      'https://dapi.kakao.com/v2/routing/walk': ok({ status: 'OK', route: { properties: { totalTime: 1801 } } }),
      'https://apis-navi.kakaomobility.com/v1/directions': ok({ routes: [{ result_code: 0, summary: { duration: 885 } }] }),
    },
    calls,
  );
  assert.deepEqual(await kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'WALK' }, fetchImpl), { minutes: 31, partial: false });
  assert.deepEqual(await kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'CAR' }, fetchImpl), { minutes: 15, partial: false });
  assert.ok(calls[1].includes('origin=126.9707%2C37.5547') && calls[1].includes('priority=RECOMMEND')); // 경도,위도 순서
});

test('실패는 종류별 KakaoError로', async () => {
  const run = (status: number) =>
    kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'WALK' }, fakeFetch({ 'https://dapi.kakao.com/v2/routing/walk': () => new Response('{}', { status }) }));
  await assert.rejects(() => run(401), (e: unknown) => e instanceof KakaoError && e.kind === 'AUTH');
  await assert.rejects(() => run(429), (e: unknown) => e instanceof KakaoError && e.kind === 'RATE_LIMIT');
  await assert.rejects(() => run(500), (e: unknown) => e instanceof KakaoError && e.kind === 'HTTP');
  const noRoute = fakeFetch({ 'https://dapi.kakao.com/v2/routing/walk': ok({ status: 'ROUTE_RESULT_NOT_FOUND' }) });
  await assert.rejects(() => kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'WALK' }, noRoute), (e: unknown) => e instanceof KakaoError && e.kind === 'NO_ROUTE');
  const abort: FetchLike = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(() => kakaoTravelMinutes('KEY', { origin: ORIGIN, destination: DEST, transport: 'WALK' }, abort), (e: unknown) => e instanceof KakaoError && e.kind === 'TIMEOUT');
});

test('장소 검색: 기준 좌표를 주면 가까운 순 (x = 경도, y = 위도)', async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch({ 'https://dapi.kakao.com/v2/local/search/keyword.json': ok({ documents: [] }) }, calls);
  assert.deepEqual(await searchPlaces('KEY', { query: '세종대', near: { lat: 37.5, lng: 127 }, size: 99 }, fetchImpl), []);
  assert.ok(calls[0].includes('x=127') && calls[0].includes('y=37.5') && calls[0].includes('sort=distance') && calls[0].includes('size=15'));
});

test('좌표 → 주소 응답: 도로명 우선 + 건물 이름, 지번만 있으면 지번, 빈 결과 · 깨진 응답은 null', () => {
  assert.deepEqual(
    parseReverse({
      meta: { total_count: 1 },
      documents: [
        {
          road_address: { address_name: '서울 광진구 능동로 209', building_name: '세종대학교 광개토관', region_1depth_name: '서울' },
          address: { address_name: '서울 광진구 군자동 98' },
        },
      ],
    }),
    { address: '서울 광진구 능동로 209', roadAddress: '서울 광진구 능동로 209', buildingName: '세종대학교 광개토관' },
  );
  // 도로명은 있고 건물 이름이 빈 글자
  assert.deepEqual(
    parseReverse({ documents: [{ road_address: { address_name: '서울 광진구 능동로 209', building_name: '' }, address: { address_name: '서울 광진구 군자동 98' } }] }),
    { address: '서울 광진구 능동로 209', roadAddress: '서울 광진구 능동로 209', buildingName: null },
  );
  // 지번만 있음 (road_address: null)
  assert.deepEqual(parseReverse({ documents: [{ road_address: null, address: { address_name: '서울 광진구 군자동 98' } }] }), {
    address: '서울 광진구 군자동 98',
    roadAddress: null,
    buildingName: null,
  });
  // 주소가 없는 곳 (바다 · 국외) · 깨진 응답
  assert.equal(parseReverse({ meta: { total_count: 0 }, documents: [] }), null);
  assert.equal(parseReverse({ documents: [{ road_address: null, address: null }] }), null);
  assert.equal(parseReverse({ documents: [{ road_address: { address_name: ' ' }, address: { address_name: '' } }] }), null);
  assert.equal(parseReverse({ documents: 'x' }), null);
  assert.equal(parseReverse(null), null);
  assert.equal(parseReverse('oops'), null);
});

test('좌표 → 주소 호출: x = 경도 · y = 위도, 키 헤더, 결과 없음은 null', async () => {
  const calls: string[] = [];
  const url = 'https://dapi.kakao.com/v2/local/geo/coord2address.json';
  const hit = fakeFetch({ [url]: ok({ documents: [{ road_address: { address_name: '서울 광진구 능동로 209', building_name: '' }, address: null }] }) }, calls);
  assert.deepEqual(await reverseAddress('KEY', { lat: 37.5509, lng: 127.0736 }, hit), {
    address: '서울 광진구 능동로 209',
    roadAddress: '서울 광진구 능동로 209',
    buildingName: null,
  });
  assert.ok(calls[0].includes('x=127.0736') && calls[0].includes('y=37.5509') && calls[0].endsWith('|KakaoAK KEY'));
  assert.equal(await reverseAddress('KEY', { lat: 0, lng: 0 }, fakeFetch({ [url]: ok({ documents: [] }) })), null);
});

test('좌표 → 주소 실패는 종류별 KakaoError로 (오류 글에 좌표가 없음)', async () => {
  const url = 'https://dapi.kakao.com/v2/local/geo/coord2address.json';
  const at = { lat: 37.5509, lng: 127.0736 };
  const run = (status: number) => reverseAddress('KEY', at, fakeFetch({ [url]: () => new Response('{}', { status }) }));
  await assert.rejects(() => run(401), (e: unknown) => e instanceof KakaoError && e.kind === 'AUTH');
  await assert.rejects(() => run(429), (e: unknown) => e instanceof KakaoError && e.kind === 'RATE_LIMIT');
  await assert.rejects(() => run(500), (e: unknown) => e instanceof KakaoError && e.kind === 'HTTP' && !e.message.includes('37.55'));
  const abort: FetchLike = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(() => reverseAddress('KEY', at, abort), (e: unknown) => e instanceof KakaoError && e.kind === 'TIMEOUT');
  const bad = fakeFetch({ [url]: () => new Response('not json', { status: 200 }) });
  await assert.rejects(() => reverseAddress('KEY', at, bad), (e: unknown) => e instanceof KakaoError && e.kind === 'BAD_RESPONSE');
});
