// Local-only external-provider fixture for Re:Spec pure-prep E2E.
// This never substitutes production Kakao API data. Real Auth, RLS,
// alarm-suggest, alarm-commit and database persistence remain in use.
import { getEnv } from './env.ts';

const INTERNAL_LOCAL_HOSTS = new Set([
  '127.0.0.1', 'localhost', 'host.docker.internal', 'kong',
]);

export function localPurePrepFixtureEnabled(): boolean {
  if (getEnv('LOCAL_PURE_PREP_E2E_FIXTURE') !== '1') return false;
  try {
    const url = new URL(getEnv('SUPABASE_URL') ?? '');
    // Both explicit opt-in and a known local Supabase gateway are required.
    // Never let a cloud deployment activate synthetic locations/travel.
    return url.protocol === 'http:' && INTERNAL_LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

type FixturePlace = {
  id: string; name: string; address: string;
  lat: number; lng: number; category: string;
};
const PLACES: readonly FixturePlace[] = [
  { id: 'pure-prep-local-gundae', name: '건대입구역 (로컬 테스트)',
    address: '서울특별시 광진구 건대입구역 부근 · 로컬 테스트 좌표',
    lat: 37.5407, lng: 127.0693, category: '로컬 테스트 장소' },
  { id: 'pure-prep-local-sejong', name: '세종대학교 (로컬 테스트)',
    address: '서울특별시 광진구 세종대학교 부근 · 로컬 테스트 좌표',
    lat: 37.5509, lng: 127.0738, category: '로컬 테스트 장소' },
];

export function localPurePrepPlaces(query: string, limit = 10): FixturePlace[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PLACES.filter((x) => x.name.toLowerCase().includes(q) ||
    (q.includes('건대') && x.id === 'pure-prep-local-gundae') ||
    (q.includes('세종') && x.id === 'pure-prep-local-sejong'))
    .slice(0, Math.max(1, Math.min(15, limit)));
}

// A fixture value, NOT a live route estimate or Kakao API response.
// The planner marks it as MANUAL so it is not misattributed to Kakao.
export const LOCAL_PURE_PREP_TRAVEL_MINUTES = 30;
