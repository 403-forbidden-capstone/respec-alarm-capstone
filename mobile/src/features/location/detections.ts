// 위치 감지 목록 · 정정의 모양과 반영 유예 규칙 — 순수 (api.ts 가짜 · real.ts 실데이터가 같이 씀)
//   화면(홈 감지 정정 줄 · 감지 안내 알림)과 일기(L4)가 읽는 계약: 레인 L2 지시서 6절 "홈 감지 정정 줄"
import type { TimeKind } from '@/features/alarm/participantTimes';

export type DetectionKind = TimeKind;

// 위치로 잡은 출발 · 도착 하나
//   settled: 친구 화면 · 일기에 반영해도 되는지 (D61 반영 유예 — 아래 isSettled)
//   isLate: 도착의 지각 판정 — null이면 보류 중("지각 확인 중", 보류 구간 −2 ~ +11분). 출발은 늘 null
export type LocationDetection = {
  participantId: string;
  kind: DetectionKind;
  at: Date;
  source: 'LOCATION';
  settled: boolean;
  isLate: boolean | null;
};

// [아니에요]를 누른 곳 — H01 홈 감지 정정 줄, NTF 감지 안내 알림 (user_edit_logs.screen)
export type RejectScreen = 'H01' | 'NTF';
export type RejectInput = { participantId: string; kind: DetectionKind; screen: RejectScreen };
// 5초 되돌리기에 넘길 것 — 지운 값(at)과 남긴 고친 값 기록 번호(editId)
export type RejectSnapshot = { participantId: string; kind: DetectionKind; at: Date; editId: string };

// D61 "친구 화면 · 일기에는 판정 뒤 20분 또는 본인 확인 뒤 반영"
//   판정 시각 = 감지 시각(at) — 감지 안내가 이탈 · 진입 신호를 받은 그때 뜨므로 (transitions DEPART_PENDING · ARRIVE). DB에 쓴 때(출발은 5분 대기 뒤)가 아님 (근거 없음 — 작성자 판단)
//   본인 확인 = 원탭 · 직접 입력 — 그러면 출처가 응답으로 바뀌어 이 목록에서 빠지므로(바로 반영해도 됨), 여기 남은 위치 값은 시간으로만 판단
export const SETTLE_AFTER_MINUTES = 20;

export function isSettled(at: Date, nowMs: number): boolean {
  return nowMs - at.getTime() >= SETTLE_AFTER_MINUTES * 60_000;
}

// [아니에요]로 지운 판정의 고친 값 — 고친 시각이 없어 표시 하나만 남김 (근거 없음 — 작성자 판단)
//   user_edit_logs.edited_value NULL은 "자동으로 되돌림"(D42 C)이라 헷갈리지 않게 객체로. 시각 글자도 아니어서 "언제 나갔어요?"(시각을 고친 값)와도 구분됨
export const REJECTED_VALUE = { rejected: true } as const;

// 고친 값 기록의 칸 이름 · 알람 종류
export const DETECTION_FIELD = { DEPART: 'departed_at', ARRIVE: 'arrived_at' } as const;
export const DETECTION_ALARM = { DEPART: 'DEPARTURE', ARRIVE: 'ARRIVE' } as const;
