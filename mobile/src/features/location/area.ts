// 장소 분류 — 카카오 category_name("교육,학문 > 학교 > 대학교")으로 대표 좌표 경고(D68) · 기본 반경(D77)
//   분류는 장소를 고를 때만 쓰고 저장하지 않음 (D5 카카오 응답 저장 금지) — 저장은 반경 숫자(dest_radius_m)만
//   분류 글자 모양: supabase/functions/_shared/kakao-parse.ts (category_name 그대로, " > "로 단계 구분)
import { BUILDING_RADIUS_M, UNKNOWN_RADIUS_M, WIDE_RADIUS_M } from './constants';

// CAMPUS 대학 캠퍼스 자체 · AREA 공원 · 테마파크 · 공항 · 경기장 · 전시장 — 둘 다 대표 좌표라 건물 도착이 안 잡힘 (D68 경고)
// WIDE 역 · 터미널 · 백화점 · 종합병원 — 넓지만 한 곳 (경고 없음, 반경만 넓게) · BUILDING 그 밖 건물 · 가게 · UNKNOWN 분류 없음
export type PlaceKind = 'CAMPUS' | 'AREA' | 'WIDE' | 'BUILDING' | 'UNKNOWN';

export type PlaceLike = { name: string; category?: string | null };

// 마지막 단계가 이것이면 학교 자체 또는 학교 안 건물 (이름으로 가름)
const SCHOOL_LEAVES = new Set(['대학교', '대학', '전문대학']);
// 어느 단계든 맞으면 — 단계 글자 전체 기준 (예: "도시근린공원", "지하철,전철")
const AREA_SEGMENTS = [/공원$/, /^(테마파크|유원지|수목원|식물원|동물원)$/, /^공항$/, /(경기장|운동장)$/, /^(컨벤션센터|전시장|박람회장)$/];
const WIDE_SEGMENTS = [/지하철|전철/, /^(기차역|철도역|기차,철도)$/, /터미널$/, /^(백화점|쇼핑몰|복합쇼핑몰|아울렛|대형마트)$/, /^(종합병원|대학병원)$/];
// 분류가 없을 때 이름만으로 캠퍼스 — "세종대학교", "서울대학교 관악캠퍼스" (근거 없음, 작성자 판단)
const CAMPUS_NAME = /^\S*대학교(\s+\S*캠퍼스)?$/;

const segmentsOf = (category: string): string[] =>
  category
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);

// 이름이 학교 자체인지 — 첫 단어 뒤가 없거나 "~캠퍼스"뿐이면 학교, "세종대학교 광개토관"처럼 뒤에 건물 이름이 붙으면 안의 건물
function namesWholeSchool(name: string): boolean {
  return name
    .trim()
    .split(/\s+/)
    .slice(1)
    .every((word) => word.endsWith('캠퍼스'));
}

export function placeKind(place: PlaceLike): PlaceKind {
  const segments = place.category ? segmentsOf(place.category) : [];
  if (!segments.length) return CAMPUS_NAME.test(place.name.trim()) ? 'CAMPUS' : 'UNKNOWN';
  const leaf = segments[segments.length - 1];
  if (SCHOOL_LEAVES.has(leaf)) return namesWholeSchool(place.name) ? 'CAMPUS' : 'BUILDING';
  if (segments.some((s) => AREA_SEGMENTS.some((re) => re.test(s)))) return 'AREA';
  if (segments.some((s) => WIDE_SEGMENTS.some((re) => re.test(s)))) return 'WIDE';
  return 'BUILDING';
}

// 대표 좌표라 건물을 다시 고르라고 경고할 곳 — "캠퍼스 대표 위치예요. 건물을 고르면 도착이 정확해요" (D68)
export function isAreaPlace(place: PlaceLike): boolean {
  const kind = placeKind(place);
  return kind === 'CAMPUS' || kind === 'AREA';
}

// 저장할 반경(m) — D77 기본안 A: 건물 · 가게 150, 역 · 공원 · 대형 시설(캠퍼스 포함) 300, 분류 없음 200
//   이름을 주면 "세종대학교 광개토관"(분류는 대학교)을 건물로 가름
export function defaultRadiusFor(category: string | null | undefined, name = ''): number {
  switch (placeKind({ name, category })) {
    case 'CAMPUS':
    case 'AREA':
    case 'WIDE':
      return WIDE_RADIUS_M;
    case 'BUILDING':
      return BUILDING_RADIUS_M;
    default:
      return UNKNOWN_RADIUS_M;
  }
}
