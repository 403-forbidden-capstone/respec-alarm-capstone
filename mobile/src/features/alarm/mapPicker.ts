// 지도 고르기 시트(MapPlaceSheet · MapView)의 순수 함수 — 지도 페이지(public/map-picker.html)와 주고받는 글자 · 주소, 핀 자리를 장소로 만드는 규칙
//   화면 없이 시험할 수 있게 부품에서 뺌. 메시지 형식은 map-picker.html 맨 위 주석과 같음
import { Platform } from 'react-native';

import { isAreaPlace } from '@/features/location/area';

import { distanceMeters } from './places';
import type { LatLng, PinAddress, Place } from './types';

// 위치를 몰라도 지도가 열리게 하는 처음 중심 — 서울 시청
export const DEFAULT_CENTER: LatLng = { lat: 37.5665, lng: 126.978 };

// 지도 페이지를 서빙하는 곳 (웹 미리보기 배포). 앱(WebView)은 이 주소의 페이지를 염
const PRODUCTION_ORIGIN = 'https://respec-alarm-capstone.vmgfh878.workers.dev';
export const MAP_PICKER_PATH = '/map-picker.html';

// 지도 페이지 주소의 origin — 개발 중 PC 서버(예: http://192.168.0.5:8081)로 바꾸려면 EXPO_PUBLIC_MAP_PICKER_ORIGIN, 웹이면 지금 열린 주소의 origin, 아니면 운영
export function resolveOrigin(override: string | undefined, webOrigin: string | undefined): string {
  const set = override?.trim().replace(/\/+$/, '');
  return set || webOrigin || PRODUCTION_ORIGIN;
}

export const MAP_PICKER_ORIGIN = resolveOrigin(
  process.env.EXPO_PUBLIC_MAP_PICKER_ORIGIN,
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined,
);

// 카카오 JavaScript 키 — 공개 값(허용 도메인으로 막음)이라 EXPO_PUBLIC_로 앱에 넣어도 됨. REST 키는 서버(place-search · place-reverse) 몫. 없으면 지도 칸에 "지도 준비 중"
export const KAKAO_JS_KEY: string | undefined = process.env.EXPO_PUBLIC_KAKAO_JS_KEY?.trim() || undefined;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// 지도 페이지 주소 — 처음 중심은 center, 키는 그대로 실음 (페이지가 카카오 SDK를 이 키로 불러옴)
export function mapPickerUrl({ origin, key, center }: { origin: string; key: string; center: LatLng }): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${MAP_PICKER_PATH}?key=${encodeURIComponent(key)}&lat=${round6(center.lat)}&lng=${round6(center.lng)}`;
}

// ---------------------------------------------------------------------------
// 메시지
// ---------------------------------------------------------------------------

export type MapErrorReason = 'no-key' | 'sdk-failed';
export type PageMessage = { type: 'ready' } | { type: 'center'; lat: number; lng: number } | { type: 'error'; reason: MapErrorReason };

const inRange = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

// 지도 페이지가 보낸 글자(JSON 글자 또는 이미 풀린 객체) → 메시지. 깨졌거나 모르는 것은 null
export function parsePageMessage(raw: unknown): PageMessage | null {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'center':
      return inRange(m.lat, 90) && inRange(m.lng, 180) ? { type: 'center', lat: m.lat, lng: m.lng } : null;
    case 'error':
      return m.reason === 'no-key' || m.reason === 'sdk-failed' ? { type: 'error', reason: m.reason } : null;
    default:
      return null;
  }
}

// 앱 → 지도 페이지 (JSON 글자). 좌표가 범위 밖이면 지도 페이지가 어차피 버리므로 보내지 않고 null
export function moveToMessage(lat: number, lng: number): string | null {
  return inRange(lat, 90) && inRange(lng, 180) ? JSON.stringify({ type: 'moveTo', lat, lng }) : null;
}

// 반경 원의 상한(m) — 지도에 터무니없이 큰 원을 그리지 않게
export const MAX_RADIUS_M = 5000;

// 핀 둘레에 반경 원 — 0 이하면 지움, 상한(MAX_RADIUS_M)을 넘으면 상한으로. 반경 고르기(다음 PR)가 부름
export function setRadiusMessage(meters: number): string {
  return JSON.stringify({ type: 'setRadius', meters: Number.isFinite(meters) && meters > 0 ? Math.min(meters, MAX_RADIUS_M) : 0 });
}

// ---------------------------------------------------------------------------
// WebView 이동 · 지도 안 뜸 감시
// ---------------------------------------------------------------------------

// 지도 페이지가 이 안에 ready를 안 보내면 못 띄운 것으로 봄 — 페이지의 SDK 불러오기 제한(10초)보다 길게 둠 (SDK는 떴는데 타일이 안 오는 경우까지 잡음)
export const MAP_READY_TIMEOUT_MS = 12000;

// ready 감시 타이머 시작 — 돌려주는 함수를 부르면 해제 (ready가 오면 · 다시 시도 · 닫힘)
export function startReadyTimer(onTimeout: () => void, ms: number = MAP_READY_TIMEOUT_MS): () => void {
  const timer = setTimeout(onTimeout, ms);
  return () => clearTimeout(timer);
}

// 지도 페이지 자신의 주소인지 — origin이 같고 경로가 /map-picker.html(Cloudflare가 .html을 떼고 /map-picker로 넘기기도 함)일 때만.
//   WebView가 다른 곳으로 이동하려 할 때 막는 기준. URL 클래스는 RN에서 origin을 못 믿어 글자로 비교 (WebView 허용 목록은 앞부분만 맞춰서 도메인 뒤에 글자를 붙인 주소도 통과하므로 여기서 경로 끝까지 확인)
export function isAllowedMapRequest(url: string, origin: string): boolean {
  const base = origin.trim().replace(/\/+$/, '').toLowerCase();
  const target = url.trim().toLowerCase();
  const page = MAP_PICKER_PATH.replace(/\.html$/, '');
  return [MAP_PICKER_PATH, page].some((path) => {
    if (!target.startsWith(base + path)) return false;
    const rest = target.slice(base.length + path.length);
    return rest === '' || rest[0] === '?' || rest[0] === '#';
  });
}

// 바깥 브라우저로 넘겨도 되는 주소 — http · https만 (intent: · file: 등은 열지 않음)
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

// ---------------------------------------------------------------------------
// 핀 자리 → 장소
// ---------------------------------------------------------------------------

// 이름도 주소도 구하지 못한 자리의 이름
export const UNNAMED_PLACE = '지정한 위치';

// 고른 장소 — Place와 같은 모양 (집 바꾸기 homePatch · 일정 장소가 그대로 받음). radiusM은 반경 고르기(다음 PR)가 채움
export type PickedPlace = Place & { radiusM?: number };

// 핀이 이 거리(m) 안에서만 움직였으면 같은 자리로 봄 — 검색 결과로 지도를 옮긴 뒤 지도가 알려 주는 가운데 좌표가 소수점 끝만 달라도 "캠퍼스 대표 위치" 경고를 지우지 않으려고
export const SAME_PIN_METERS = 5;

export function isSamePin(a: LatLng, b: LatLng): boolean {
  return distanceMeters(a, b) <= SAME_PIN_METERS;
}

// [이 위치로 정하기]가 돌려줄 장소 — 이름은 직접 쓴 것 → 검색 결과 이름 → 핀 자리 건물 이름 → 주소 순. 주소는 핀 자리 주소를 우선(핀을 움직였을 수 있음), 없으면 검색 결과 주소
export function placeFromPin({
  point,
  typedName,
  picked,
  pinAddress,
}: {
  point: LatLng;
  typedName: string;
  picked?: Pick<Place, 'name' | 'address'> | null;
  pinAddress?: PinAddress | null;
}): PickedPlace {
  const address = pinAddress?.address.trim() || picked?.address?.trim() || undefined;
  const name = typedName.trim() || picked?.name.trim() || pinAddress?.name?.trim() || address || UNNAMED_PLACE;
  return { name, ...(address ? { address } : {}), lat: point.lat, lng: point.lng };
}

// 핀 자리 주소를 못 구했을 때 문구
export const ADDRESS_FAILED = '주소를 못 불러왔어요';

// 핀이 멈춘 뒤 이만큼 지나야 주소를 찾음 (끌 때마다 카카오를 부르지 않게)
export const REVERSE_DELAY_MS = 400;

// 캠퍼스 대표 좌표 경고 문구 (D68)
export const AREA_WARNING = '캠퍼스 대표 위치예요. 건물을 고르면 도착이 정확해요';

// 핀 자리 주소를 이 안에 못 받으면 못 구한 것으로 봄 — [이 위치로 정하기]가 주소를 기다리다 영영 막히지 않게
export const REVERSE_TIMEOUT_MS = 8000;

// 핀이 검색 결과에서 이만큼(m) 안이면 그 결과의 이름 · 주소를 [이 위치로 정하기]에 씀 — 미세 조정은 같은 장소, 멀리 옮기면 다른 장소
export const NEAR_PICK_METERS = 100;

type PlacePoint = Pick<Place, 'name' | 'address' | 'category' | 'lat' | 'lng'>;

const pointOf = (place: PlacePoint): LatLng | null =>
  typeof place.lat === 'number' && typeof place.lng === 'number' ? { lat: place.lat, lng: place.lng } : null;

// 이름 · 주소를 빌려 줄 검색 결과 — 핀이 그 근처일 때만, 아니면 null
export function namingPick<T extends PlacePoint>(picked: T | null, point: LatLng | null): T | null {
  const at = picked && pointOf(picked);
  return picked && at && point && distanceMeters(at, point) <= NEAR_PICK_METERS ? picked : null;
}

// 캠퍼스 대표 좌표 경고를 보일지 — 캠퍼스 · 지역 장소를 검색해 골랐고 핀이 아직 그 자리일 때 (핀을 움직이면 사라짐)
export function showsAreaWarning(picked: PlacePoint | null, point: LatLng | null): boolean {
  const at = picked && pointOf(picked);
  return !!picked && !!at && !!point && isAreaPlace(picked) && isSamePin(at, point);
}
