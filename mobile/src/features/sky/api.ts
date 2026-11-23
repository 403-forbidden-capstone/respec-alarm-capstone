// 지금 날씨 읽기 — Open-Meteo (키 없음 · 무료). 가짜 데이터 모드는 서버를 안 부르고 맑음
//   위치는 사용자 위치가 아니라 서울 고정 좌표 — 사용자 위치를 바깥 서비스에 보내지 않음. 사용자 위치로 바꾸려면 동의 문구부터 정해야 함
//   못 읽으면 맑음으로 둠 (시간대 색만 보임). 배경 꾸밈이라 실패를 화면에 알리지 않음
import { isMock } from '@/lib/mode';

import { DEFAULT_SKY, SKY_REFRESH_MS, skyKindOf, type Sky } from './sky';

const SEOUL = { latitude: 37.55, longitude: 127.07 };
const URL =
  'https://api.open-meteo.com/v1/forecast' +
  `?latitude=${SEOUL.latitude}&longitude=${SEOUL.longitude}` +
  '&current=weather_code&daily=sunrise,sunset&timeformat=unixtime&timezone=Asia%2FSeoul&forecast_days=1';
const TIMEOUT_MS = 5_000;

type Response = { current?: { weather_code?: number }; daily?: { sunrise?: number[]; sunset?: number[] } };

let cached: { at: number; sky: Sky } | null = null;

function fromSeconds(s: number | undefined) {
  return typeof s === 'number' ? new Date(s * 1000) : null;
}

export async function getSky(): Promise<Sky> {
  if (isMock()) return DEFAULT_SKY;
  if (cached && Date.now() - cached.at < SKY_REFRESH_MS) return cached.sky;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: abort.signal });
    if (!res.ok) return cached?.sky ?? DEFAULT_SKY;
    const body = (await res.json()) as Response;
    const code = body.current?.weather_code;
    if (typeof code !== 'number') return cached?.sky ?? DEFAULT_SKY;
    const sky: Sky = { kind: skyKindOf(code), sunrise: fromSeconds(body.daily?.sunrise?.[0]), sunset: fromSeconds(body.daily?.sunset?.[0]) };
    cached = { at: Date.now(), sky };
    return sky;
  } catch {
    return cached?.sky ?? DEFAULT_SKY;
  } finally {
    clearTimeout(timer);
  }
}

// 시험용 — 기억해 둔 값을 비움
export function resetSkyCache() {
  cached = null;
}
