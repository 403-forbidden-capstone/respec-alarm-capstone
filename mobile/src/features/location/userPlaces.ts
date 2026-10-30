// 자주 가는 곳 (학교 · 회사 · 알바 등 최대 5개) — 모양 · 검사 · 행 변환의 순수 함수. 읽고 쓰는 곳은 api.ts (가짜) · realPlaces.ts (Supabase)
//   헤드 설계 10/30 "집 · 회사 위치를 지도로": 집은 profiles(home_*), 나머지는 표 user_places (supabase/migrations/20261030190000_user_places.sql)
//   위치는 누구에게도 공유하지 않음 (Q13 · D59) — 본인만 읽고 씀. 좌표는 로그에 남기지 않음
import { UserError } from '@/lib/errors';

export const MAX_USER_PLACES = 5; // DB 트리거(enforce_user_places_limit)와 같은 수
export const LABEL_MAX = 20; // DB check user_places_label_length와 같은 수
export const NAME_MAX = 200; // 장소 이름 · 주소 길이 상한 (profiles.home_name varchar(200)과 같게)
export const RADIUS_MIN_M = 100; // DB check user_places_radius_m_range와 같은 범위
export const RADIUS_MAX_M = 500;
export const SUGGESTED_LABELS = ['학교', '회사', '알바']; // 지도 시트 이름 칩 후보 — 이미 쓴 것은 뺌
export const LIMIT_MESSAGE = '자주 가는 곳은 5개까지 저장할 수 있어요';

// 화면이 보는 모양
export type UserPlace = {
  label: string; // 이름표 (학교 · 회사 · 알바…) — 사람마다 하나씩, 칩에 보임
  name: string; // 장소 이름 (지도에서 고른 곳의 주소나 검색 이름)
  address?: string;
  lat: number;
  lng: number;
  radiusM?: number; // 지오펜스 반경(m). 없으면 앱 기본값
};

export type UserPlaceInput = UserPlace;

// user_places 행 (supabase/migrations 20261030190000) — numeric은 숫자로 옴
export type UserPlaceRow = {
  label: string;
  name: string;
  address: string | null;
  lat: number | string;
  lng: number | string;
  radius_m: number | null;
};

export const USER_PLACE_COLUMNS = 'label, name, address, lat, lng, radius_m';

// 이름표 다듬기 — 앞뒤 공백 뺌, 안쪽 공백은 하나로, 20자까지만
export function cleanLabel(raw: string): string {
  return Array.from(raw.trim().replace(/\s+/g, ' ')).slice(0, LABEL_MAX).join('').trim();
}

const cutText = (raw: string) => Array.from(raw.trim()).slice(0, NAME_MAX).join('');

const inRange = (v: number, limit: number) => Number.isFinite(v) && Math.abs(v) <= limit;

// 저장 전 검사 · 정리 — 이름표 · 장소 이름이 비었거나 좌표가 범위 밖이면 UserError. 반경은 100~500으로 맞춤(소수는 반올림)
//   DB check와 같은 규칙이라 서버 오류 원문이 화면에 나오지 않게 앞에서 막음
export function normalizeInput(input: UserPlaceInput): UserPlaceInput {
  const label = cleanLabel(input.label);
  if (!label) throw new UserError('이름을 입력해 주세요');
  const name = cutText(input.name);
  if (!name) throw new UserError('장소 이름을 알 수 없어요. 다른 장소를 골라 주세요');
  if (!inRange(input.lat, 90) || !inRange(input.lng, 180)) throw new UserError('이 장소는 위치를 몰라 저장할 수 없어요. 다른 장소를 골라 주세요');
  const address = input.address ? cutText(input.address) : '';
  const radiusM =
    input.radiusM != null && Number.isFinite(input.radiusM) ? Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Math.round(input.radiusM))) : undefined;
  return { label, name, ...(address ? { address } : {}), lat: input.lat, lng: input.lng, ...(radiusM != null ? { radiusM } : {}) };
}

export function fromRow(row: UserPlaceRow): UserPlace {
  return {
    label: row.label,
    name: row.name,
    ...(row.address ? { address: row.address } : {}),
    lat: Number(row.lat),
    lng: Number(row.lng),
    ...(row.radius_m != null ? { radiusM: row.radius_m } : {}),
  };
}

// 저장할 행 — 같은 이름표로 덮어쓸 때(upsert) 옛 주소 · 반경이 남지 않게 없는 칸도 null로 늘 보냄
export function toRow(userId: string, input: UserPlaceInput) {
  return {
    user_id: userId,
    label: input.label,
    name: input.name,
    address: input.address ?? null,
    lat: input.lat,
    lng: input.lng,
    radius_m: input.radiusM ?? null,
  };
}

export function usedLabels(places: readonly UserPlace[]): Set<string> {
  return new Set(places.map((p) => p.label));
}

// 새 이름표가 5개 한도를 넘기는지 — 이미 있는 이름표를 덮어쓰는 건 개수가 늘지 않아 통과
export function wouldExceedLimit(places: readonly UserPlace[], label: string): boolean {
  return places.length >= MAX_USER_PLACES && !usedLabels(places).has(cleanLabel(label));
}

// 지도 시트 이름 칩 — 학교 · 회사 · 알바 중 아직 안 쓴 것
export function unusedLabels(places: readonly UserPlace[]): string[] {
  const used = usedLabels(places);
  return SUGGESTED_LABELS.filter((l) => !used.has(l));
}

// 지도 시트에서 [이 위치로 정하기]로 온 장소 → 저장할 값
//   저장 규칙: 시트의 "이름" 칸이 이름표(label), 장소 이름(name)은 핀 자리 주소 → 없으면 시트가 준 이름(검색한 이름 · 건물 이름)
//   · 시트는 이름 칸에 쓴 글자를 name으로 돌려줌 (비웠으면 검색 이름 → 건물 이름 → 주소 순, mapPicker placeFromPin) → 그 글자를 이름표로 씀
//     (20자까지만, 길면 잘림). 이름 칸을 비웠으면 주소나 검색 이름이 이름표가 됨
//   · replacing(바꾸기)이면 이름표는 그대로 두고 위치만 바꿈
//   좌표가 없는 장소는 저장할 수 없어 null
export function inputFromPick(
  picked: { name: string; address?: string; lat?: number; lng?: number; radiusM?: number },
  replacing?: string,
): UserPlaceInput | null {
  if (typeof picked.lat !== 'number' || typeof picked.lng !== 'number') return null;
  const label = replacing ?? picked.name;
  const name = picked.address?.trim() || picked.name;
  return {
    label,
    name,
    ...(picked.address ? { address: picked.address } : {}),
    lat: picked.lat,
    lng: picked.lng,
    ...(picked.radiusM != null ? { radiusM: picked.radiusM } : {}),
  };
}

// Supabase 오류 → 던질 오류. 5개 제한 트리거(54000)만 이유를 알려 주고(UserError), 나머지는 그대로 돌려줘 화면이 기본 문구로 바꿈
export function placeError(error: { code?: string | null }): unknown {
  return error.code === '54000' ? new UserError(LIMIT_MESSAGE) : error;
}
