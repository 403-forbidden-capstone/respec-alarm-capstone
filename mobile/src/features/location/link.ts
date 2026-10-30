// 감지 안내 알림 ↔ 정정 화면(/detection)을 잇는 주소 — 순수 (알림 만들기 · 알림 탭 처리 · 화면이 같이 씀)
//   주소 모양: respecalarm://detection?kind=DEPART&participantId=<id>&at=<ms>  (앱 스킴은 app.json scheme)
//   at = 감지 시각(ms) — 출발은 이탈 시각, 도착은 진입 시각. 알림 identifier도 같은 세 값으로 고정해 같은 판정이 쌓이지 않게 함
import type { DetectionKind } from './detections';

export const DETECTION_SCHEME = 'respecalarm';
export const DETECTION_PATH = 'detection';

// 참여 조건 번호는 uuid 모양(8-4-4-4-12 16진수) — 낯선 값이 주소로 들어와 조회에 쓰이지 않게
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DetectionLink = { kind: DetectionKind; participantId: string; at: number };

export function buildDetectionLink({ kind, participantId, at }: DetectionLink): string {
  return `${DETECTION_SCHEME}://${DETECTION_PATH}?kind=${kind}&participantId=${encodeURIComponent(participantId)}&at=${at}`;
}

// 같은 판정이면 같은 알림 번호 — 다시 띄우면 쌓이지 않고 덮어씀
export function detectionNoticeId({ kind, participantId, at }: DetectionLink): string {
  return `detect-${kind}-${participantId}-${at}`;
}

// 화면 쿼리(문자열 또는 배열) → 값. 모양이 틀리면 null
export function parseDetectionParams(params: Record<string, string | string[] | undefined>): DetectionLink | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const kind = one(params.kind);
  const participantId = one(params.participantId);
  const atText = one(params.at);
  if (kind !== 'DEPART' && kind !== 'ARRIVE') return null;
  if (!participantId || !UUID_SHAPE.test(participantId) || !atText || !/^\d+$/.test(atText)) return null;
  const at = Number(atText);
  return Number.isSafeInteger(at) ? { kind, participantId, at } : null;
}

// 알림의 data.url → 값. 우리 주소가 아니거나(다른 알림 · 낯선 값) 모양이 틀리면 null
export function parseDetectionLink(url: unknown): DetectionLink | null {
  if (typeof url !== 'string') return null;
  const match = new RegExp(String.raw`^(?:${DETECTION_SCHEME}://|/)${DETECTION_PATH}\?([^#]*)$`).exec(url);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const pair of match[1].split('&')) {
    const [key, value = ''] = pair.split('=');
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      return null; // 깨진 % 글자
    }
  }
  return parseDetectionParams(params);
}
