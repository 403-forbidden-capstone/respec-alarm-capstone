// 카카오 REST 호출 — 장소 검색 · 좌표 → 주소(카카오 로컬) · 이동시간(카카오맵 대중교통 · 도보, 카카오모빌리티 자동차)
// 인증은 모두 `Authorization: KakaoAK {REST API 키}` (같은 REST 키, Edge 비밀값 KAKAO_REST_API_KEY)
// 응답은 저장 · 재사용하지 않음 (카카오 약관, 7장 7.1.2) — 이 파일은 아무것도 기억하지 않고 분만 돌려줌
// 키는 이 파일에서 읽지 않고 인자로 받음 (fetch를 바꿔 끼워 node --test로 시험)
import type { LatLng } from './calc/travel.ts';
import type { Transport } from './calc/types.ts';
import { parseCarDirections, parsePlaces, parseReverse, parseTransit, parseWalk, type KakaoPlace, type ReversePlace } from './kakao-parse.ts';

export const KAKAO_TIMEOUT_MS = 4_000; // 7장 7.1.2 "타임아웃 4초"

const LOCAL_KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const COORD2ADDRESS_URL = 'https://dapi.kakao.com/v2/local/geo/coord2address.json';
const TRANSIT_URL = 'https://dapi.kakao.com/v2/routing/publictraffic';
const WALK_URL = 'https://dapi.kakao.com/v2/routing/walk';
const CAR_URL = 'https://apis-navi.kakaomobility.com/v1/directions';

export type KakaoFailure = 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'NO_ROUTE' | 'HTTP' | 'BAD_RESPONSE';

export class KakaoError extends Error {
  readonly kind: KakaoFailure;
  readonly status?: number;

  constructor(kind: KakaoFailure, message: string, status?: number) {
    super(message);
    this.name = 'KakaoError';
    this.kind = kind;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, key: string, fetchImpl: FetchLike, timeoutMs = KAKAO_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `KakaoAK ${key}` }, signal: controller.signal });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new KakaoError('TIMEOUT', '카카오 응답이 늦어요');
    throw new KakaoError('HTTP', '카카오에 연결하지 못했어요');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new KakaoError('AUTH', '카카오 키가 맞지 않거나 이 API 권한이 없어요', res.status);
  if (res.status === 429) throw new KakaoError('RATE_LIMIT', '카카오 호출 한도를 넘었어요', res.status);
  if (!res.ok) throw new KakaoError('HTTP', `카카오 오류 (${res.status})`, res.status);
  try {
    return await res.json();
  } catch {
    throw new KakaoError('BAD_RESPONSE', '카카오 응답을 읽지 못했어요');
  }
}

// ---------------------------------------------------------------------------
// 장소 검색 (place-search)
// ---------------------------------------------------------------------------

export async function searchPlaces(
  key: string,
  args: { query: string; near?: LatLng; size?: number },
  fetchImpl: FetchLike = fetch,
): Promise<KakaoPlace[]> {
  const url = new URL(LOCAL_KEYWORD_URL);
  url.searchParams.set('query', args.query);
  url.searchParams.set('size', String(Math.min(15, Math.max(1, args.size ?? 10))));
  if (args.near) {
    // 가까운 순으로: 기준 좌표를 주면 거리 순 정렬 (x = 경도, y = 위도)
    url.searchParams.set('x', String(args.near.lng));
    url.searchParams.set('y', String(args.near.lat));
    url.searchParams.set('sort', 'distance');
  }
  return parsePlaces(await getJson(url.toString(), key, fetchImpl));
}

// ---------------------------------------------------------------------------
// 좌표 → 주소 (place-reverse)
// ---------------------------------------------------------------------------

// 지도 핀 좌표의 주소. 주소가 없는 곳(바다 · 국외 등)은 null. 좌표를 로그 · 오류 글에 남기지 않음
export async function reverseAddress(key: string, at: LatLng, fetchImpl: FetchLike = fetch): Promise<ReversePlace | null> {
  const url = new URL(COORD2ADDRESS_URL);
  url.searchParams.set('x', String(at.lng)); // x = 경도, y = 위도
  url.searchParams.set('y', String(at.lat));
  return parseReverse(await getJson(url.toString(), key, fetchImpl));
}

// ---------------------------------------------------------------------------
// 이동시간 (alarm-suggest)
// ---------------------------------------------------------------------------

const coord = (p: LatLng) => `${p.lng},${p.lat}`;
const toMinutes = (seconds: number) => Math.max(0, Math.ceil(seconds / 60)); // 올림: 모자라게 잡아 늦는 것보다 낫게

function unwrap<T extends { ok: true }>(parsed: T | { ok: false; reason: 'NO_ROUTE' | 'BAD_RESPONSE'; detail?: string }): T {
  if (parsed.ok) return parsed;
  throw new KakaoError(parsed.reason === 'NO_ROUTE' ? 'NO_ROUTE' : 'BAD_RESPONSE', `경로를 못 찾았어요 (${parsed.detail ?? parsed.reason})`);
}

async function walkSeconds(key: string, from: LatLng, to: LatLng, fetchImpl: FetchLike): Promise<number> {
  const url = new URL(WALK_URL);
  url.searchParams.set('start_x', String(from.lng));
  url.searchParams.set('start_y', String(from.lat));
  url.searchParams.set('end_x', String(to.lng));
  url.searchParams.set('end_y', String(to.lat));
  return unwrap(parseWalk(await getJson(url.toString(), key, fetchImpl))).seconds;
}

// 이동 수단에 맞는 카카오 API로 분 단위 이동시간을 구함. 실패하면 KakaoError
//   대중교통 · 버스 · 지하철: 대중교통 경로 + (응답에 빠진) 출발지 → 첫 승차 · 마지막 하차 → 목적지 도보를 도보 API로 더함
//     앞뒤 도보를 못 구하면 대중교통 구간만 (partial: true)
export async function kakaoTravelMinutes(
  key: string,
  args: { origin: LatLng; destination: LatLng; transport: Transport },
  fetchImpl: FetchLike = fetch,
): Promise<{ minutes: number; partial: boolean }> {
  const { origin, destination, transport } = args;

  if (transport === 'CAR') {
    const url = new URL(CAR_URL);
    url.searchParams.set('origin', coord(origin));
    url.searchParams.set('destination', coord(destination));
    url.searchParams.set('priority', 'RECOMMEND');
    return { minutes: toMinutes(unwrap(parseCarDirections(await getJson(url.toString(), key, fetchImpl))).seconds), partial: false };
  }

  if (transport === 'WALK') {
    return { minutes: toMinutes(await walkSeconds(key, origin, destination, fetchImpl)), partial: false };
  }

  const url = new URL(TRANSIT_URL);
  url.searchParams.set('start_x', String(origin.lng));
  url.searchParams.set('start_y', String(origin.lat));
  url.searchParams.set('end_x', String(destination.lng));
  url.searchParams.set('end_y', String(destination.lat));
  const transit = unwrap(parseTransit(await getJson(url.toString(), key, fetchImpl), transport === 'BUS' ? 'BUS' : transport === 'SUBWAY' ? 'SUBWAY' : undefined));

  let seconds = transit.seconds;
  let partial = false;
  const legs: Promise<number>[] = [];
  if (!transit.startsWithWalk) {
    if (transit.firstPoint) legs.push(walkSeconds(key, origin, transit.firstPoint, fetchImpl));
    else partial = true; // 첫 승차 지점을 응답에서 못 읽음
  }
  if (!transit.endsWithWalk) {
    if (transit.lastPoint) legs.push(walkSeconds(key, transit.lastPoint, destination, fetchImpl));
    else partial = true;
  }
  for (const leg of await Promise.allSettled(legs)) {
    if (leg.status === 'fulfilled') seconds += leg.value;
    else partial = true;
  }
  return { minutes: toMinutes(seconds), partial };
}
