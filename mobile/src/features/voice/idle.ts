// 실시간 음성 대화(Gemini Live)의 30초 무발화 자동 종료 판정 — 순수 계산 (시각은 부르는 쪽이 넘김, hooks/useLiveVoice가 1초마다 물음)
//   듣는 중(연결됨 · 마이크 전송 중)에만 잼: AI가 말하는 동안(마이크 막힘)은 멈추고, 마이크가 다시 열리면 새 30초
//   '실제 말'의 근거는 두 가지 — Gemini 받아쓰기(me, 확실함)와 페이지의 소리 크기 감지(vad, 받아쓰기보다 빠름)
//     · 받아쓰기가 오면 새 30초
//     · 소리 감지가 켜져 있는 동안은 끝내지 않음(말하는 중에 끊지 않게). 꺼지면 받아쓰기 · AI 답이 올 시간(VAD_GRACE_MS)을 남김
//     · 받아쓰기 없이 소리 감지로만 늘리는 것(주변 소음)은 듣기 시작부터 IDLE_MS + NOISE_MAX_MS까지 — 소음으로 끝없이 늘지 않게
//       (실제 말이면 말하는 도중에도 받아쓰기가 조금씩 와서 새 30초가 됨)
export const IDLE_MS = 30_000;
export const VAD_GRACE_MS = 8_000;
export const NOISE_MAX_MS = 15_000;

export interface IdleWatch {
  deadline: number | null; // null = 재지 않음 (AI가 말하는 중 · 연결 전)
  cap: number; // 받아쓰기 없이 늘릴 수 있는 끝
  vadSince: number | null; // 소리 감지가 켜진 시각
}

export const idleOff = (): IdleWatch => ({ deadline: null, cap: 0, vadSince: null });

/** 듣기 시작(연결 직후 · AI 말이 끝나 마이크가 다시 열림 · 서버 처리가 끝남) — 새 30초 */
export const idleArm = (t: number): IdleWatch => ({ deadline: t + IDLE_MS, cap: t + IDLE_MS + NOISE_MAX_MS, vadSince: null });

/** 사용자 말이 받아쓰기로 확인됨 — 새 30초 (재고 있을 때만) */
export const idleHeard = (w: IdleWatch, t: number): IdleWatch => (w.deadline === null ? w : idleArm(t));

/** 소리 감지 켜짐 · 꺼짐 */
export function idleVad(w: IdleWatch, t: number, active: boolean): IdleWatch {
  if (w.deadline === null) return w;
  if (active) return w.vadSince === null ? { ...w, vadSince: t } : w;
  if (w.vadSince === null) return w;
  return { ...w, deadline: Math.max(w.deadline, Math.min(t + VAD_GRACE_MS, w.cap)), vadSince: null };
}

/** 지금 끝낼 때인가 — 소리 감지가 켜져 있으면(소음 한도 안) 아직 아님 */
export function idleExpired(w: IdleWatch, t: number): boolean {
  if (w.deadline === null || t < w.deadline) return false;
  return !(w.vadSince !== null && t < w.cap);
}
