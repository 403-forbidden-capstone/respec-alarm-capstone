// 홈 감지 정정 줄의 글자 · 정렬 — 순수 (화면 부품 · 훅이 같이 씀)
//   줄에는 시각 · 자동 감지만 — 지각 여부는 쓰지 않음 (D61: 지각은 본인 확인 전엔 남에게 안 보이고, 본인 화면의 "지각 N분"은 다른 곳에 이미 있음)
import { formatTime } from '@/lib/format';

import type { DetectionKind, LocationDetection } from './detections';

export const KIND_WORD: Record<DetectionKind, string> = { DEPART: '출발', ARRIVE: '도착' };

// "출발 오전 8:30 · 자동 감지"
export function detectionLabel(kind: DetectionKind, at: Date): string {
  return `${KIND_WORD[kind]} ${formatTime(at)} · 자동 감지`;
}

export function erasedMessage(kind: DetectionKind, at: Date): string {
  return `${KIND_WORD[kind]} ${formatTime(at)} 기록을 지웠어요`;
}

export function restoredMessage(kind: DetectionKind, at: Date): string {
  return `${KIND_WORD[kind]} ${formatTime(at)} 기록을 되돌렸어요`;
}

// 같은 판정을 가리키는 키 — 줄 key · 지운 줄 빼기
export const detectionKey = (d: Pick<LocationDetection, 'participantId' | 'kind' | 'at'>): string => `${d.kind}:${d.participantId}:${d.at.getTime()}`;

// 시각순, 같은 시각이면 출발이 먼저
export function sortDetections(list: readonly LocationDetection[]): LocationDetection[] {
  return [...list].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'DEPART' ? -1 : 1));
}
