// 하늘 배경 — 홈 위쪽을 지금 날씨 · 시간대에 맞는 색과 그림으로 물들이고, 탭 화면 네 곳의 바탕 전체에 그 색을 살짝 섞음 (알람 · 친구 · AI는 그림 없이 톤만)
// 여기는 계산만 (시간대 판정 · 날씨 코드 → 종류 · 높이별 색). 그리기는 components/SkyBackdrop, 날씨 읽기는 api.ts
import { colors, skyTint } from '@/theme';

export type SkyKind = 'clear' | 'cloudy' | 'rain' | 'snow';
export type SkyPhase = 'dawn' | 'morning' | 'day' | 'dusk' | 'night';

export const SKY_KINDS: readonly SkyKind[] = ['clear', 'cloudy', 'rain', 'snow'];
export const SKY_PHASES: readonly SkyPhase[] = ['dawn', 'morning', 'day', 'dusk', 'night'];

// 날씨를 못 읽었을 때 · 가짜 데이터 모드의 기본 — 시간대만 반영된 맑은 하늘
export type Sky = { kind: SkyKind; sunrise: Date | null; sunset: Date | null };
export const DEFAULT_SKY: Sky = { kind: 'clear', sunrise: null, sunset: null };

export const SKY_HEIGHT = 300; // 물드는 높이 — 화면 맨 위부터. 이 아래는 톤만 섞인 화면 바탕(skyBase)
// 이 높이부터는 보조 글자(sub)를 써도 대비 4.5 : 1 이상. 그 위에는 본문 색(ink) 글자만 둠 (홈의 날짜 · 인사말)
export const SKY_SUB_TEXT_FROM = 120;
// 이 높이부터는 하늘 위 보조 글자(skySub)로 대비 4.5 : 1 이상 (알람 · 친구 탭 제목 아래 설명 글)
export const SKY_LEAD_FROM = 40;

const MIN = 60_000;
// 해 뜨는 · 지는 시각을 모를 때 쓰는 값 (자정부터 분)
const FALLBACK_SUNRISE = 6 * 60 + 30;
const FALLBACK_SUNSET = 18 * 60 + 30;

function minuteOf(t: Date) {
  return t.getHours() * 60 + t.getMinutes();
}

// 시간대 — 해 뜰 무렵(앞뒤 40분) · 아침(오전 11시까지) · 낮 · 해 질 녘(지기 60분 전 ~ 30분 뒤) · 밤
export function skyPhase(at: Date, sunrise: Date | null = null, sunset: Date | null = null): SkyPhase {
  const m = minuteOf(at);
  const rise = sunrise ? minuteOf(sunrise) : FALLBACK_SUNRISE;
  const set = sunset ? minuteOf(sunset) : FALLBACK_SUNSET;
  if (m < rise - 40 || m >= set + 30) return 'night';
  if (m < rise + 40) return 'dawn';
  if (m >= set - 60) return 'dusk';
  if (m < 11 * 60) return 'morning';
  return 'day';
}

// 해 뜨기 전인지 — 자정부터 해 뜰 때까지는 인사말이 '새벽' (겨울 7시는 새벽, 여름 5시 반은 아침)
export function isBeforeSunrise(at: Date, sunrise: Date | null = null): boolean {
  return minuteOf(at) < (sunrise ? minuteOf(sunrise) : FALLBACK_SUNRISE);
}

// WMO 날씨 코드(Open-Meteo weather_code) → 종류. 모르는 코드는 맑음
//   0 · 1 맑음 / 2 · 3 구름 · 45 · 48 안개 / 51~67 · 80~82 비 · 95~99 뇌우 / 71~77 · 85 · 86 눈
export function skyKindOf(code: number): SkyKind {
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) return 'rain';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  return 'clear';
}

export function skyTop(kind: SkyKind, phase: SkyPhase): string {
  return skyTint[kind][phase];
}

function channels(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// 두 색을 섞음 — t가 0이면 a, 1이면 b
export function mixHex(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

// 맨 위에서 y만큼 내려온 자리의 바탕 색 — 위에서 빨리 풀리고 아래로 갈수록 천천히 (글자가 놓이는 자리는 거의 화면 바탕)
export function skyColorAt(top: string, y: number): string {
  const t = Math.min(1, Math.max(0, y / SKY_HEIGHT));
  return mixHex(top, skyBase(top), 1 - (1 - t) ** 4);
}

// 화면 전체 바탕 — 원래 바탕에 그 하늘 색을 살짝 섞음 (하늘 아래쪽도 날씨 · 시간대 톤을 따라감)
export const SKY_TONE = 0.12;
export function skyBase(top: string): string {
  return mixHex(colors.bg, top, SKY_TONE);
}

// 포인트 색 — 하늘 색에서 색상(hue)만 가져와 진하게. 켜진 스위치 · 채운 버튼 · 글자 버튼이 그 시각 하늘과 같은 계열이 됨
//   채도 36% · 밝기 33% 고정이라 어느 하늘에서도 흰 바탕 · 흰 글자와 대비 4.5 : 1 이상 (시험으로 확인)
const ACCENT_S = 0.36;
const ACCENT_L = 0.33;
export function skyAccent(top: string): string {
  const [r, g, b] = channels(top).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  }
  const q = ACCENT_L + ACCENT_S * ACCENT_L; // 밝기 0.5 미만일 때의 식
  const p = 2 * ACCENT_L - q;
  const part = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${part(h + 1 / 3)}${part(h)}${part(h - 1 / 3)}`.toUpperCase();
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 글자 대비 (WCAG) — 색 값을 바꿀 때 시험이 이걸로 잼
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// 홈 인사말 — 하루 중 때(새벽 · 아침 · 오후 · 저녁)에 날씨를 얹음. 맑으면 원래 인사말 그대로
export type DayPart = 'dawn' | 'morning' | 'afternoon' | 'evening';
const PART_WORD: Record<DayPart, string> = { dawn: '새벽이에요', morning: '아침이에요', afternoon: '오후예요', evening: '저녁이에요' };
const CLEAR_GREETING: Record<DayPart, string> = { dawn: '고요한 새벽이에요', morning: '좋은 아침이에요', afternoon: '좋은 오후예요', evening: '차분한 저녁이에요' };
const KIND_WORD: Record<Exclude<SkyKind, 'clear'>, string> = { cloudy: '흐린', rain: '비 오는', snow: '눈 오는' };

export function skyGreeting(kind: SkyKind, part: DayPart): string {
  return kind === 'clear' ? CLEAR_GREETING[part] : `${KIND_WORD[kind]} ${PART_WORD[part]}`;
}

// 미리 보기(/dev/sky)에서 고른 시간대에 맞는 인사말 때
export function dayPartOfPhase(phase: SkyPhase): DayPart {
  return phase === 'dawn' ? 'dawn' : phase === 'morning' ? 'morning' : phase === 'day' ? 'afternoon' : 'evening';
}

// 날씨를 다시 읽는 간격
export const SKY_REFRESH_MS = 30 * MIN;
