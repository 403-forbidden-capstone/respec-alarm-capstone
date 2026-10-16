// 카카오 응답 읽기 — 순수 함수라 샘플 JSON으로 시험함 (kakao-parse.test.ts). 호출은 kakao.ts
// 근거 (2026-10-15 공식 문서 확인):
//   · 장소 키워드 검색  GET https://dapi.kakao.com/v2/local/search/keyword.json  (카카오 로컬)
//       documents[]: id · place_name · address_name(지번) · road_address_name(도로명) · x(경도) · y(위도) · category_name
//   · 대중교통 경로    GET https://dapi.kakao.com/v2/routing/publictraffic  (카카오맵 REST API, 2026-07 추가)
//       status(OK · STARTNODES_NULL · ENDNODES_NULL · EQUAL_POINTS · INVALID_REQUEST · NO_RESULTS), routes[].properties{ type, totalTime(초), ... }
//       routes[].steps[]{ properties{ type: BUS|SUBWAY|WALKING, time(초) }, path.points[[x,y]] }
//       출발지 → 첫 승차 · 하차 → 목적지 도보 구간은 응답에 없음 (카카오 데브톡 공식 답변: "도보 경로조회 API를 병행 호출")
//   · 도보 경로        GET https://dapi.kakao.com/v2/routing/walk  — status(OK · SAME_POINT · ...), route.properties.totalTime(초)
//   · 자동차 길찾기    GET https://apis-navi.kakaomobility.com/v1/directions  (카카오모빌리티) — routes[].result_code(0 = 성공), summary{ distance(m), duration(초) }
//       ※ 자동차 길찾기 응답의 단위는 확인 못 함 (샘플 값으로 초로 읽음) — 키가 오면 한 번 불러서 확인할 것
import type { LatLng } from './calc/travel.ts';

export type KakaoPlace = { id: string; name: string; address: string; lat: number; lng: number; category?: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function parsePlaces(json: unknown): KakaoPlace[] {
  const docs = isObject(json) && Array.isArray(json.documents) ? json.documents : [];
  const out: KakaoPlace[] = [];
  for (const d of docs) {
    if (!isObject(d)) continue;
    const lat = num(d.y);
    const lng = num(d.x);
    const id = text(d.id);
    const name = text(d.place_name);
    if (lat == null || lng == null || !id || !name) continue;
    const category = text(d.category_name);
    out.push({
      id,
      name,
      address: text(d.road_address_name) || text(d.address_name),
      lat,
      lng,
      ...(category ? { category } : {}),
    });
  }
  return out;
}

export type ParseFailure = { ok: false; reason: 'NO_ROUTE' | 'BAD_RESPONSE'; detail?: string };

export type TransitSummary = {
  ok: true;
  seconds: number; // 고른 경로의 총 소요 (도보 앞뒤 구간은 빠져 있을 수 있음)
  startsWithWalk: boolean; // 첫 단계가 도보면 앞 구간이 이미 들어 있음
  endsWithWalk: boolean;
  firstPoint?: LatLng; // 첫 승차 지점
  lastPoint?: LatLng; // 마지막 하차 지점
};

const point = (p: unknown): LatLng | undefined => {
  if (!Array.isArray(p)) return undefined;
  const lng = num(p[0]);
  const lat = num(p[1]);
  return lat != null && lng != null ? { lat, lng } : undefined;
};

// 가장 빨리 가는 경로 하나. wanted로 버스만 · 지하철만 고를 수 있고, 맞는 게 없으면 전체에서 고름
export function parseTransit(json: unknown, wanted?: 'BUS' | 'SUBWAY'): TransitSummary | ParseFailure {
  if (!isObject(json)) return { ok: false, reason: 'BAD_RESPONSE' };
  const status = text(json.status);
  if (status === 'EQUAL_POINTS') return { ok: true, seconds: 0, startsWithWalk: true, endsWithWalk: true };
  if (status === 'NO_RESULTS' || status === 'STARTNODES_NULL' || status === 'ENDNODES_NULL') return { ok: false, reason: 'NO_ROUTE', detail: status };
  if (status !== 'OK' || !Array.isArray(json.routes)) return { ok: false, reason: 'BAD_RESPONSE', detail: status };

  const routes = json.routes.filter(isObject).flatMap((r) => {
    const props = isObject(r.properties) ? r.properties : {};
    const seconds = num(props.totalTime);
    return seconds == null ? [] : [{ r, seconds, type: text(props.type) }];
  });
  if (!routes.length) return { ok: false, reason: 'NO_ROUTE' };
  const preferred = wanted ? routes.filter((x) => x.type === wanted) : routes;
  const best = (preferred.length ? preferred : routes).reduce((a, b) => (b.seconds < a.seconds ? b : a));

  const steps = Array.isArray(best.r.steps) ? best.r.steps.filter(isObject) : [];
  const typeOf = (s: Record<string, unknown> | undefined) => (s && isObject(s.properties) ? text(s.properties.type) : '');
  const points = (s: Record<string, unknown> | undefined): unknown[] =>
    s && isObject(s.path) && Array.isArray(s.path.points) ? (s.path.points as unknown[]) : [];
  const first = steps[0];
  const last = steps[steps.length - 1];
  return {
    ok: true,
    seconds: best.seconds,
    startsWithWalk: typeOf(first) === 'WALKING',
    endsWithWalk: typeOf(last) === 'WALKING',
    firstPoint: point(points(first)[0]),
    lastPoint: point(points(last)[points(last).length - 1]),
  };
}

export function parseWalk(json: unknown): { ok: true; seconds: number } | ParseFailure {
  if (!isObject(json)) return { ok: false, reason: 'BAD_RESPONSE' };
  const status = text(json.status);
  if (status === 'SAME_POINT') return { ok: true, seconds: 0 };
  if (status === 'OK' && isObject(json.route) && isObject(json.route.properties)) {
    const seconds = num(json.route.properties.totalTime);
    if (seconds != null) return { ok: true, seconds };
    return { ok: false, reason: 'BAD_RESPONSE', detail: status };
  }
  const noRoute = ['START_LINK_NOT_FOUND', 'END_LINK_NOT_FOUND', 'TOO_MANY_SEARCH_LINK', 'TOO_FAR_AWAY', 'ROUTE_RESULT_NOT_FOUND'];
  return { ok: false, reason: noRoute.includes(status) ? 'NO_ROUTE' : 'BAD_RESPONSE', detail: status };
}

export function parseCarDirections(json: unknown): { ok: true; seconds: number } | ParseFailure {
  const routes = isObject(json) && Array.isArray(json.routes) ? json.routes : [];
  const first = routes.find(isObject);
  if (!first) return { ok: false, reason: 'BAD_RESPONSE' };
  const code = num(first.result_code);
  if (code === 104) return { ok: true, seconds: 0 }; // 출발지와 목적지가 같음
  if (code !== 0) return { ok: false, reason: 'NO_ROUTE', detail: `result_code ${code ?? '?'}` };
  const seconds = isObject(first.summary) ? num(first.summary.duration) : undefined;
  return seconds == null ? { ok: false, reason: 'BAD_RESPONSE', detail: 'summary.duration' } : { ok: true, seconds };
}
