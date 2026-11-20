// 위치로 잡은 출발 · 도착의 [아니에요] 정정과 5초 되돌리기 — 화면이 같이 쓰는 순서 (감지 안내 /detection · 홈 감지 정정 줄)
//   서버 값 지우기(rejectDetection) → 폰 판정 기억 맞춤(forgetGeoDetection) → 폰 예약 · 감시 계획 다시 맞춤(resyncLocation)
//   되돌리기는 반대로: undoReject → restoreGeoDetection → resyncLocation. 던질 수 있음(서버 오류) — 부르는 쪽이 useAction으로 감싸 토스트로 보임
import { syncNow } from '@/lib/alarmSync';

import { rejectDetection, undoReject, type DetectionKind, type RejectScreen, type RejectSnapshot } from './api';
import { forgetGeoDetection, restoreGeoDetection } from './correct';
import { withdrawDetectionNotice } from './notice';
import { syncLocation } from './register';
import { loadState } from './store';

export const UNDO_SECONDS = 5;

// 지운 결과 — snapshot이 있으면 서버 값을 지웠고 5초 안에 undoErase로 되돌릴 수 있음. 없으면 폰에만 있던 판정(5분 대기 중이던 출발 등)을 잊은 것이라 되돌릴 수 없음
export type ErasedDetection = { snapshot: RejectSnapshot | null; participantId: string; kind: DetectionKind; at: number };

// 지운 뒤 · 되돌린 뒤 — 폰 예약(원탭 알림)과 감시 계획을 다시 맞춤. 기다리지 않고, 실패해도 정정은 그대로 (둘 다 던지지 않음)
export function resyncLocation() {
  void syncNow();
  void syncLocation({ ignoreThrottle: true });
}

// at = 지우려는 값의 시각(ms). 지금 위치 값의 시각과 다르면(그 뒤 더 새 판정이 들어옴) 서버 값은 안 건드림
// 돌려주는 값 null = 지울 위치 값이 없음 (이미 원탭 · 직접 입력으로 바뀌었거나 이미 지움)
export async function eraseDetection(target: { participantId: string; kind: DetectionKind; at: number }, screen: RejectScreen): Promise<ErasedDetection | null> {
  const { participantId, kind } = target;
  const snapshot = await rejectDetection({ participantId, kind, screen, at: target.at });
  // 서버에서 지운 값의 시각 기준으로 폰 기억도 맞춤 (서버 값이 없거나 시각이 달라 못 지웠으면 같은 시각(target.at)으로 — 폰에만 있는 판정을 찾아 잊음)
  const at = snapshot ? snapshot.at.getTime() : target.at;
  const forgot = await forgetGeoDetection({ participantId, kind, at }, { voidAlways: snapshot != null });
  if (!snapshot && !forgot) return null;
  // 알림창에 남은 "출발 · 도착 감지" 안내도 거둠 — 알림 번호의 시각은 폰이 잡은 시각(target.at)이고 서버에 쓴 값(snapshot.at)과 다를 수 있어 둘 다
  for (const noticeAt of new Set([target.at, at])) withdrawDetectionNotice({ kind, participantId, at: noticeAt });
  resyncLocation();
  return { snapshot, participantId, kind, at };
}

// 5초 안 되돌리기. false = 그 사이 다른 값(원탭 등)이 들어왔거나 이미 되돌림 — 덮어쓰지 않음
export async function undoErase(snapshot: RejectSnapshot): Promise<boolean> {
  const ok = await undoReject(snapshot);
  if (!ok) return false;
  await restoreGeoDetection({ participantId: snapshot.participantId, kind: snapshot.kind, at: snapshot.at.getTime() });
  resyncLocation(); // 돌아온 값을 계획이 다시 읽도록 — correct.ts restoreGeoDetection 주석
  return true;
}

// 대화(A02)로 출발 · 도착 시각을 직접 고친 뒤 — [아니에요]와 같은 정리 (감지 안내 거두기 + 폰 판정 기억 맞춤 + 폰 예약 · 감시 계획 다시 맞춤). 던지지 않음 (정정은 이미 서버에 쓰였음)
//   serverAt = 고치기 전 서버의 위치 값 시각(없으면 null). 폰 기억에 남은 같은 참여 조건 · 종류의 판정(아직 서버에 못 쓴 출발 후보 · 도착)도 같이 정리 — 안내 알림 번호가 폰이 잡은 시각이라 둘 다 찾음
export async function settleCorrectedDetection(target: { participantId: string; kind: DetectionKind; serverAt: number | null }): Promise<void> {
  try {
    const { participantId, kind, serverAt } = target;
    const state = await loadState();
    const remembered = (kind === 'DEPART' ? [...state.pending, ...state.departed] : state.arrived).filter((x) => x.participantId === participantId).map((x) => x.at);
    const ats = new Set<number>(serverAt != null ? [serverAt, ...remembered] : remembered);
    if (!ats.size) return;
    for (const at of ats) {
      await forgetGeoDetection({ participantId, kind, at }, { voidAlways: at === serverAt });
      withdrawDetectionNotice({ kind, participantId, at });
    }
    resyncLocation();
  } catch (e) {
    if (__DEV__) console.warn('[location] 대화 정정 뒤 정리 실패', e);
  }
}
