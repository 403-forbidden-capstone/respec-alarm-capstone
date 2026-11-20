// 그룹원 한 사람의 상태 단계 — 그룹 화면(mobile features/social/map.ts wakeStateOf)과 기상 알람 그룹 안내(group-status.ts)가 같이 씀
//   규칙은 map.ts에 있던 그대로 옮김 (목업 G02 · G03, 11/19 지형님). 여기서는 단계만 고르고, 화면 글자 · 점 · 음성 문구는 쓰는 쪽이 정함
//   위가 우선: 도착 → 출발(약속 + 60분 전이면 이동 중) → 준비 시작 → 서버 기상 단계. 기상 알람이 없는 날 출발 · 도착 공유를 켠 사람은 준비 알람 예정
// 이 파일은 Deno · 앱(@shared) 둘 다 불러서 날짜 읽기를 받음 — 앱은 lib/dbTime parseDbTime(Hermes가 마이크로초를 못 읽는 문제)
export type WakePhaseRow = {
  wake_status: string; // SCHEDULED · RINGING · DISMISSED · MISSED · CONFIRMED · NO_ALARM
  departed_at?: string | null;
  arrived_at?: string | null;
  trip_visible?: boolean;
  trip_appointment_at?: string | null;
  prepare_alarm_at?: string | null;
  prepare_started_at?: string | null;
};

export type WakePhase = 'ARRIVED' | 'MOVING' | 'DEPARTED' | 'PREPARING' | 'WOKE' | 'RINGING' | 'RANG' | 'SCHEDULED' | 'PREP_SCHEDULED' | 'NO_ALARM';

type Parse = (value: string) => Date;
const parseIso: Parse = (value) => new Date(value);

// 출발 뒤 이 시간(분)이 지나면 도착 기록이 없어도 '이동 중'을 안 붙임 (약속 + 60분, 홈 이동 중 줄과 같음)
export const MOVING_UNTIL_AFTER_APPOINTMENT_MINUTES = 60;

// 이동 중 = 출발했고 도착이 없고 약속 + 60분 전. 약속 시각을 모르면(옛 값) 이동 중으로 봄
export function isMoving(row: Pick<WakePhaseRow, 'departed_at' | 'arrived_at' | 'trip_appointment_at'>, current: Date, parse: Parse = parseIso): boolean {
  if (!row.departed_at || row.arrived_at) return false;
  if (!row.trip_appointment_at) return true;
  return current.getTime() < parse(row.trip_appointment_at).getTime() + MOVING_UNTIL_AFTER_APPOINTMENT_MINUTES * 60_000;
}

// 서버 6단계 → 화면 3단계 + 알람 없음. 울림 · 해제 · 미확인은 단계 하나(RANG)로 묶음 — 글자만 '알람 울리는 중' · '알람 울림 · 기상 확인 전'으로 나눔 (7-아 · 7-바 · D61)
//   모르는 값은 RANG — 기상 완료로 잘못 보이지 않게
export function stageOf(status: string): 'SCHEDULED' | 'RANG' | 'WOKE' | 'NO_ALARM' {
  switch (status) {
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'CONFIRMED':
      return 'WOKE';
    case 'NO_ALARM':
      return 'NO_ALARM';
    default:
      return 'RANG';
  }
}

// '준비 중'은 짐작이 아니라 준비 시작 체크가 있을 때만 — 기상 확인 뒤 준비 시작 체크 전에는 출발 · 도착 공유를 켰어도 '기상 완료'
export function wakePhaseOf(row: WakePhaseRow, current: Date, parse: Parse = parseIso): WakePhase {
  if (row.arrived_at) return 'ARRIVED';
  if (row.departed_at) return isMoving(row, current, parse) ? 'MOVING' : 'DEPARTED';
  if (row.prepare_started_at) return 'PREPARING';
  switch (stageOf(row.wake_status)) {
    case 'WOKE':
      return 'WOKE';
    case 'RANG':
      return row.wake_status === 'RINGING' ? 'RINGING' : 'RANG';
    case 'SCHEDULED':
      return 'SCHEDULED';
    default:
      return row.trip_visible && row.prepare_alarm_at ? 'PREP_SCHEDULED' : 'NO_ALARM';
  }
}
