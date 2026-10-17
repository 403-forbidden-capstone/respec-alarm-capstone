// H03 저장 때 길찾기를 못 해서 서버가 어림값만 가진 경우 — 7장 7.1.2 "근사값은 사용자 확인 → MANUAL" (시험: __tests__/travelConfirm.test.ts)
//   alarm-commit은 길찾기 값(API)이나 사용자가 정한 값(MANUAL)만 저장함. 길찾기가 안 되면 직선거리 어림(ESTIMATE)이나 내 지난 이동 중앙값(CACHED)을
//   502 ROUTE_UNAVAILABLE의 details.fallback으로 돌려주고, 앱이 그 분을 사용자에게 보여 확인받은 뒤 MANUAL로 다시 보내야 저장됨
//   (좌표가 없어 어림도 없으면 fallback이 없음 — 예상 이동에 직접 입력해야 함)
import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

export type TravelFallbackSource = 'ESTIMATE' | 'CACHED';

export type TravelFallback = { minutes: number; source: TravelFallbackSource };

// 저장이 확인 대기로 멈춤 — 화면이 확인 시트를 띄우고, 확인하면 이 분을 예상 이동(직접 입력)으로 넣어 다시 저장
export class TravelConfirmNeeded extends UserError implements TravelFallback {
  readonly minutes: number;
  readonly source: TravelFallbackSource;

  constructor(fallback: TravelFallback) {
    super('이동시간을 확인해 주세요');
    this.name = 'TravelConfirmNeeded';
    this.minutes = fallback.minutes;
    this.source = fallback.source;
  }
}

// alarm-commit이 ROUTE_UNAVAILABLE과 함께 준 어림값. 모양이 다르면(fallback 없음 · 모르는 출처 · 분이 숫자가 아님) null
export function travelFallbackOf(error: unknown): TravelFallback | null {
  if (!(error instanceof EdgeError) || error.code !== 'ROUTE_UNAVAILABLE') return null;
  const fallback = (error.details as { fallback?: { minutes?: unknown; source?: unknown } | null } | null | undefined)?.fallback;
  if (!fallback || typeof fallback.minutes !== 'number' || !Number.isFinite(fallback.minutes)) return null;
  if (fallback.source !== 'ESTIMATE' && fallback.source !== 'CACHED') return null;
  return { minutes: Math.max(1, Math.round(fallback.minutes)), source: fallback.source };
}

// 확인 시트 문구
export function travelConfirmMessage(fallback: TravelFallback): string {
  return fallback.source === 'CACHED'
    ? `길찾기를 못 해 최근 이동 기록으로 이동시간을 ${fallback.minutes}분으로 잡았어요. 이 값으로 저장할까요?`
    : `길찾기를 못 해 이동시간을 대략 ${fallback.minutes}분으로 잡았어요. 이 값으로 저장할까요?`;
}

export const TRAVEL_CONFIRM_OK = '이 값으로 저장';
export const TRAVEL_CONFIRM_EDIT = '예상 이동을 직접 고칠게요';

// 미리 보기(alarm-suggest)가 길찾기 값을 못 줬을 때 H03 이동 조건 칸에 붙는 안내 — 저장하면 확인이 필요하거나 직접 입력해야 하는 상태
export type TravelProblem = 'ESTIMATE' | 'CACHED' | 'MANUAL_REQUIRED';

export const TRAVEL_PROBLEM_NOTE: Record<TravelProblem, string> = {
  ESTIMATE: '길찾기를 못 해 대략적인 값이에요. 저장할 때 이 값으로 할지 물어봐요',
  CACHED: '길찾기를 못 해 최근 이동 기록으로 잡았어요. 저장할 때 이 값으로 할지 물어봐요',
  MANUAL_REQUIRED: '이 장소의 위치를 몰라 이동시간을 구하지 못했어요. 예상 이동을 직접 입력해 주세요',
};
