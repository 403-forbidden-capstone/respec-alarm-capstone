// [아니에요] 정정을 폰의 판정 기억에 맞춤 — 서버 값(rejectDetection · undoReject)과 별개로, 폰이 그 판정을 계속 "있는 것"으로 보지 않게
//   · forgetGeoDetection  지운 판정을 폰 기억에서 잊음: 대기 중 · 확정 · 도착 기록 + 아직 못 쓴 기록(보관함)에서 빼고 voided로 둠 → 다음 이탈 · 진입을 다시 받아 자동으로 채움
//   · restoreGeoDetection 5초 안에 되돌렸을 때 voided에서 뺌. 돌아온 DB 값은 계획(planRegions이 DB를 읽은 것)에 들어 있어야 셈되므로,
//     부르는 쪽이 이어서 syncLocation({ ignoreThrottle: true })로 계획을 다시 읽게 함 (안 읽으면 다음 읽기까지 이탈이 새 출발로 붙을 수 있음, transitions.ts restoreDetection)
//   읽기 · 바꾸기 · 저장은 줄(withLock) 안에서 — 백그라운드 신호 해석과 겹치지 않게. 읽기가 실패하면 던지지 않고 false (정정 자체는 서버에서 이미 끝난 일)
import { withLock } from './lock';
import { errorText } from './native';
import { commit, loadActions, loadPlan, loadState } from './store';
import { forgetDetection, restoreDetection, type GeoState, type VoidedDetection } from './transitions';
import type { RegionPlan } from './regions';

// appointmentAt은 모르면 비워 둠 — 폰 기억(대기 · 확정 · 도착) → 계획 순으로 찾고, 그래도 없으면 감지 시각으로 (voided는 약속 뒤 하루가 지나면 버려지므로 크게 틀리지 않음)
export type CorrectedDetection = Pick<VoidedDetection, 'kind' | 'participantId' | 'at'> & { appointmentAt?: number };

function fullDetection(state: GeoState, plan: RegionPlan, d: CorrectedDetection): VoidedDetection {
  const remembered = [...state.pending, ...state.departed, ...state.arrived].find((x) => x.participantId === d.participantId)?.appointmentAt;
  const planned = [...plan.participants, ...plan.untracked].find((p) => p.participantId === d.participantId)?.appointmentAt;
  return { kind: d.kind, participantId: d.participantId, at: d.at, appointmentAt: d.appointmentAt ?? remembered ?? planned ?? d.at };
}

// 폰이 그 판정(같은 시각)을 기억하고 있는가 — 대기 중 · 확정 출발 / 잡은 도착 / 보관함의 못 쓴 기록
const remembers = (state: GeoState, d: CorrectedDetection): boolean => {
  const same = (x: { participantId: string; at: number }) => x.participantId === d.participantId && x.at === d.at;
  return d.kind === 'DEPART' ? state.pending.some(same) || state.departed.some(same) : state.arrived.some(same);
};

// 폰 기억에서 그 판정을 잊음. 돌려주는 값 = 폰이 그 판정을 기억하고 있어서 잊었는지 (false = 기억에 없었거나 읽기 · 저장 실패)
//   voidAlways = 서버 값을 지웠을 때 true — 폰 기억에 없어도 voided로 둠 (계획에 남은 옛 DB 값이 셈되지 않게)
//   기억에 없고 voidAlways도 아니면 아무것도 저장하지 않음 (지난 알림을 눌러도 더 새 판정을 건드리지 않게)
export function forgetGeoDetection(detection: CorrectedDetection, options: { voidAlways?: boolean } = {}): Promise<boolean> {
  return withLock(async () => {
    try {
      const [state, plan, queued] = await Promise.all([loadState(), loadPlan(), loadActions()]);
      const inQueue = queued.some((a) => a.type === detection.kind && a.participantId === detection.participantId && a.at === detection.at);
      const found = remembers(state, detection) || inQueue;
      if (!found && !options.voidAlways) return false;
      await commit({
        state: forgetDetection(state, fullDetection(state, plan, detection)),
        // 아직 서버에 못 쓴 같은 기록이 남아 있으면 같이 뺌 — 안 빼면 지운 값이 나중에 다시 써짐
        ...(inQueue ? { actions: queued.filter((a) => !(a.type === detection.kind && a.participantId === detection.participantId && a.at === detection.at)) } : {}),
      });
      return found;
    } catch (e) {
      if (__DEV__) console.warn('[location] 정정을 폰 기억에 반영하지 못함', errorText(e));
      return false;
    }
  });
}

// 5초 안에 되돌렸을 때 — voided에서 뺌. 돌려주는 값 = 반영했는지 (읽기 · 저장 실패면 false)
export function restoreGeoDetection(detection: CorrectedDetection): Promise<boolean> {
  return withLock(async () => {
    try {
      const state = await loadState();
      await commit({ state: restoreDetection(state, { ...detection, appointmentAt: detection.appointmentAt ?? detection.at }) });
      return true;
    } catch (e) {
      if (__DEV__) console.warn('[location] 되돌리기를 폰 기억에 반영하지 못함', errorText(e));
      return false;
    }
  });
}
