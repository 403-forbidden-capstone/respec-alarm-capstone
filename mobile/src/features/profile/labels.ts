// 프로필 값의 한국어 이름 — 설정 줄과 온보딩 선택지가 같이 씀 (한 곳에서 고침)
import type { TransportType, WakeMargin, WakeSensitivity } from './types';

export const TRANSPORT_NAME: Record<TransportType, string> = {
  TRANSIT: '대중교통',
  BUS: '버스',
  SUBWAY: '지하철',
  CAR: '자차',
  WALK: '도보',
};

// 잠귀 D92 기본안 A — 3개 → 보통 · 보통 · 강, 계산 반영은 L1
export const WAKE_SENSITIVITY_NAME: Record<WakeSensitivity, string> = {
  LIGHT: '작은 소리에도 깨요',
  NORMAL: '보통이에요',
  HEAVY: '큰 소리도 잘 못 들어요',
};

// 깨우는 여유 D63 — 기록의 0.7 · 0.8 · 0.9 분위수, 예측 반영은 L1
export const WAKE_MARGIN_NAME: Record<WakeMargin, string> = {
  TIGHT: '빠듯',
  NORMAL: '보통',
  LOOSE: '넉넉',
};
