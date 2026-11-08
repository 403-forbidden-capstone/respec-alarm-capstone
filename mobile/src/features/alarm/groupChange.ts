// 공동 약속 변경 푸시(GROUP_APPT_CHANGED) 받은 뒤 할 일 — 순수 함수 (친구 9장, 세션약속 1절 '공동 약속 푸시 데이터')
//   CANCELED = 만든 사람이 지움 → 그 약속 알람을 폰에서 지움(맞추기)
//   CHANGED + needsConfirm false = 서버가 내 알람을 이미 고침 → 받아 와서 폰에 걺(맞추기)
//   CHANGED + needsConfirm true = 5분 넘게 늦춰질 예정이라 보류했거나 이동시간을 못 구함 → 확인 화면(/alarm/changed?id=<약속 id>)
//   푸시를 받는 곳(알림 눌렀을 때 · 앱이 켜져 있을 때)은 푸시 앱 PR이 이 함수를 불러 씀
import type { AlarmSettingsDraft, AppointmentDetail, IntensityAxis } from './types';

export type GroupChangeAction = { type: 'CANCELED' | 'SYNC' | 'CONFIRM'; appointmentId: string };

export function groupChangeAction(data: unknown): GroupChangeAction | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'GROUP_APPT_CHANGED' || typeof d.appointmentId !== 'string' || !d.appointmentId) return null;
  const appointmentId = d.appointmentId;
  if (d.change === 'CANCELED') return { type: 'CANCELED', appointmentId };
  if (d.change !== 'CHANGED') return null;
  // 알림 데이터가 글자로 올 수도 있어(플랫폼마다 다름) 'true'도 확인으로 봄
  const confirm = d.needsConfirm === true || d.needsConfirm === 'true';
  return { type: confirm ? 'CONFIRM' : 'SYNC', appointmentId };
}

// 확인 화면 [새 시각으로 맞추기] — 지금 저장된 내 조건(출발지 · 수단 · 여유 · 직접 고른 값 · 종류별 켜기 · 직접 고른 강도) 그대로 다시 저장해 서버가 바뀐 약속 시각으로 다시 계산하게 함
export function settingsDraftOf(saved: AppointmentDetail): AlarmSettingsDraft {
  const level = (axis: IntensityAxis) => (saved.intensity.axes[axis].manual ? saved.intensity.axes[axis].level : null);
  return {
    ...saved.edits,
    kinds: Object.fromEntries(saved.alarms.filter((x) => x.kind !== 'ARRIVE').map((x) => [x.kind, x.enabled])),
    levels: { sound: level('sound'), voice: level('voice'), vibration: level('vibration') },
  };
}
