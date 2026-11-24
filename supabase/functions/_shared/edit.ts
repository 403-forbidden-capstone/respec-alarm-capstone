// 일정 수정 · 삭제의 순수 계산 — appointment-edit이 DB에 쓸 내용을 정하는 부분 (node --test, edit.test.ts)
//   · 어느 범위(이번만 / 이후 모두)가 무엇을 하는가 (scopeEffect)
//   · 고친 값을 약속 행에 반영 (applyPatch) — 바뀐 것만 찾아냄
//   · 알람 시각이 어떻게 바뀌는지 (alarmChanges) · 확인이 먼저인지 (needsConfirm, D67)
//   · 이후 모두 고치기 · 지우기에서 지울 뒤 회차 (laterRowsToDelete)
//   · 앞 일정이 바뀌거나 지워질 때 같은 날 다음 일정의 기상 알람을 다시 판정 (wakeAction, 7장 7.1.3 — hasEarlierWake 그대로)
//   · 고칠 수 있는 사람 (editorVerdict — 개인 약속은 만든 사람, 공동 약속은 그룹원 누구나)
// 읽고 쓰는 쪽은 edit-run.ts, 요청 읽기는 edit-request.ts. 앱 가짜 모드(mobile/src/features/alarm/api.ts updateAppointment · deleteAppointment)가 돌려주는 것과 같은 의미로 맞춤
import { hasEarlierWake, type Importance, type SameDayWake } from './calc/index.ts';
import type { AlarmWrite } from './commit-core.ts';
import type { AlarmRow } from './plan-core.ts';

// ---------------------------------------------------------------------------
// 범위 · 예외 표시
// ---------------------------------------------------------------------------

// 앱 EditScope와 같은 글자 (mobile/src/features/alarm/types.ts) — this = 이번 회차만, following = 이번 회차와 그 뒤 모두. 반복이 아니면 둘 다 그 일정 하나
export type EditScope = 'this' | 'following';
export const EDIT_SCOPES = ['this', 'following'] as const satisfies readonly EditScope[];

// appointments.exception_kind (마이그레이션 20261030150000_appointment_edit.sql)
export type ExceptionKind = 'EDITED' | 'CANCELED';

// 알람이 이만큼(분) 이상 늦춰지면 저장 전에 확인 (앱 schedule.ts CONFIRM_MOVE_MINUTES와 같은 값 · D67). 앞당김은 묻지 않음
export const CONFIRM_MOVE_MINUTES = 5;

export type ScopeEffect = {
  span: 'ROW' | 'FROM_HERE'; // ROW = 이 행만, FROM_HERE = 이 행 + 뒤 회차 정리
  mark: 'KEEP' | 'EDITED' | 'CLEAR'; // 이 행의 예외 표시: 그대로 / 이번만 고침으로 / 지움(이 행이 새 기준이 됨)
  deleteLater: boolean; // 뒤 회차(기록 없는 것)를 지워 alarm-roll이 새 기준으로 다시 만들게 함
  rule: { kind: 'KEEP' } | { kind: 'SET'; value: string } | { kind: 'CLEAR_ALL' }; // 반복 규칙: 그대로 / 이 행에 새 규칙 / 묶음 모든 행의 규칙을 비움(반복 끔)
};

// 고치기의 범위 효과. patchRule: undefined = 요청에 반복 칸 없음, null = 반복 끔
//   · 공동 약속 · 반복 아닌 일정 = 그 행 하나 (반복 아닌 일정에 반복을 켜는 것은 이 행에 규칙을 넣음 → alarm-roll이 다음 회차를 만듦)
//   · 반복 + 이번만: 이 행만 고치고 예외(EDITED) 표시. 반복 요일 변경은 무시 (앱 가짜 모드와 같음 — L6 안건후보: 이번만 고칠 때 반복 요일 기본안 = 무시)
//   · 반복 + 이후 모두: 이 행이 새 기준(예외 표시 지움) + 뒤 회차 지움. 규칙을 비우면(null) 묶음 모든 행의 규칙을 비움 — 안 그러면 앞 회차가 기준이 되어 roll이 다시 만듦
export function scopeEffect(args: { recurring: boolean; group: boolean; scope: EditScope; patchRule: string | null | undefined; currentRule: string | null }): ScopeEffect {
  const { recurring, group, scope, patchRule, currentRule } = args;
  if (group) return { span: 'ROW', mark: 'KEEP', deleteLater: false, rule: { kind: 'KEEP' } };
  if (!recurring) {
    return { span: 'ROW', mark: 'KEEP', deleteLater: false, rule: typeof patchRule === 'string' ? { kind: 'SET', value: patchRule } : { kind: 'KEEP' } };
  }
  if (scope === 'this') return { span: 'ROW', mark: 'EDITED', deleteLater: false, rule: { kind: 'KEEP' } };
  const rule: ScopeEffect['rule'] =
    patchRule === undefined || patchRule === currentRule ? { kind: 'KEEP' } : patchRule === null ? { kind: 'CLEAR_ALL' } : { kind: 'SET', value: patchRule };
  return { span: 'FROM_HERE', mark: 'CLEAR', deleteLater: true, rule };
}

// 지우기의 범위 효과 — 반복이고 공동 약속이 아니어야 범위를 가림
//   · this: 행은 두고 알람만 지움 + CANCELED 표시 (행을 지우면 alarm-roll이 그 날짜를 다시 만듦)
//   · following: 뒤 회차 + 이 행을 지우고 남은 행의 규칙을 비움 (alarm-roll 대상에서 빠짐, 지난 행은 기록으로)
//   · ROW: 한 번짜리(반복 아님) · 공동 약속 = 약속 + 참여 + 알람을 지움
export type DeleteMode = 'ROW' | 'CANCEL_THIS' | 'FROM_HERE';
export function deleteMode(args: { recurring: boolean; group: boolean; scope: EditScope }): DeleteMode {
  if (args.group || !args.recurring) return 'ROW';
  return args.scope === 'this' ? 'CANCEL_THIS' : 'FROM_HERE';
}

// ---------------------------------------------------------------------------
// 고칠 수 있는 사람
// ---------------------------------------------------------------------------

// 약속을 고치거나 지울 수 있는 사람. 개인 약속은 RLS가 만든 사람에게만 보여 주고, 공동 약속은 그 그룹에 참여 중인 그룹원 누구나 (#619 — 만든 사람(creator_id)은 기록일 뿐 권한 판단에 안 씀)
//   그룹 참여 여부는 edit-run.ts assertGroupMember · DB 정책 appointments_update · appointments_delete_creator가 봄. NOT_VISIBLE = 못 찾음(없거나 남의 개인 약속)
export function editorVerdict(args: { row: { creator_id: string | null; group_id: string | null } | null; userId: string }): 'OK' | 'NOT_VISIBLE' {
  if (!args.row) return 'NOT_VISIBLE';
  if (args.row.group_id != null || args.row.creator_id === args.userId) return 'OK';
  return 'NOT_VISIBLE';
}

// ---------------------------------------------------------------------------
// 고친 값 반영
// ---------------------------------------------------------------------------

export type PlaceValue = { name: string; lat?: number; lng?: number };

// 요청에서 읽은 고칠 값 — 안 넣은 칸은 그대로
export type AppointmentPatch = {
  title?: string;
  at?: Date;
  destination?: PlaceValue;
  importance?: Importance;
  recurrenceRule?: string | null; // null = 반복 끔
};

export type PatchableRow = {
  title: string;
  appointment_at: string;
  dest_name: string;
  dest_lat: number | string | null;
  dest_lng: number | string | null;
  importance: Importance;
};

export type PatchResult = {
  next: { title: string; appointment_at: string; dest_name: string; dest_lat: number | null; dest_lng: number | null; importance: Importance };
  changed: { title: boolean; at: boolean; place: boolean; importance: boolean };
  any: boolean; // 약속 행의 칸이 하나라도 바뀜 (반복 규칙은 따로 — scopeEffect)
  affectsAlarms: boolean; // 알람 시각 · 강도가 달라질 수 있음 (시각 · 장소 · 중요도). 제목만이면 false
};

const sameCoord = (a: number | string | null | undefined, b: number | null | undefined) => (a == null || b == null ? a == null && b == null : Math.abs(Number(a) - b) < 1e-6);

export function applyPatch(row: PatchableRow, patch: AppointmentPatch): PatchResult {
  const title = patch.title !== undefined ? patch.title.trim() : row.title;
  const at = patch.at ?? new Date(row.appointment_at);
  const place = patch.destination;
  const destName = place ? place.name.trim() : row.dest_name;
  // 이름이 바뀌었는데 좌표가 없으면 옛 좌표는 다른 곳이므로 비움 (길찾기를 새로 구하려면 좌표가 있어야 함)
  // 이름이 그대로면 옛 좌표를 유지 (편집 시트가 장소 문자열을 매번 보내도 제목만 고친 요청이 막히지 않게)
  const keepCoord = !place || (place.lat == null && place.lng == null && destName === row.dest_name);
  const destLat = keepCoord ? (row.dest_lat == null ? null : Number(row.dest_lat)) : (place?.lat ?? null);
  const destLng = keepCoord ? (row.dest_lng == null ? null : Number(row.dest_lng)) : (place?.lng ?? null);
  const importance = patch.importance ?? row.importance;
  const changed = {
    title: title !== row.title,
    at: at.getTime() !== Date.parse(row.appointment_at),
    place: destName !== row.dest_name || !sameCoord(row.dest_lat, destLat) || !sameCoord(row.dest_lng, destLng),
    importance: importance !== row.importance,
  };
  const any = changed.title || changed.at || changed.place || changed.importance;
  return {
    next: { title, appointment_at: at.toISOString(), dest_name: destName, dest_lat: destLat, dest_lng: destLng, importance },
    changed,
    any,
    affectsAlarms: changed.at || changed.place || changed.importance,
  };
}

// ---------------------------------------------------------------------------
// 바뀌는 알람 · 확인 (D67)
// ---------------------------------------------------------------------------

export type AlarmChangeKind = 'WAKE' | 'PREPARE' | 'DEPARTURE';
const CHANGE_KINDS: readonly string[] = ['WAKE', 'PREPARE', 'DEPARTURE'];

// 앱 AlarmChange({ kind, from, to })의 서버 쪽 모양 — 시각은 ISO 글자
export type AlarmChangeLine = { kind: AlarmChangeKind; from: string; to: string };

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

// 저장하면 시각이 바뀌는 기상 · 준비 · 출발 (앱 schedule.ts changedAlarms와 같은 의미 — 도착 목표는 안 셈).
//   고치기 전 알람(before)과 같은 종류가 고친 뒤에도 켜진 채 있고(after) 분 단위로 시각이 다른 것만. 새로 생기거나 사라지는 알람(그날 첫 일정이 바뀌어 기상이 붙고 떨어짐)은 줄에 넣지 않음
export function alarmChanges(before: readonly Pick<AlarmRow, 'alarm_type' | 'scheduled_at'>[], after: readonly Pick<AlarmWrite, 'alarm_type' | 'scheduled_at' | 'is_enabled'>[]): AlarmChangeLine[] {
  const out: AlarmChangeLine[] = [];
  for (const kind of ['WAKE', 'PREPARE', 'DEPARTURE'] as const) {
    const prev = before.find((x) => x.alarm_type === kind);
    const next = after.find((x) => x.alarm_type === kind && CHANGE_KINDS.includes(x.alarm_type));
    if (prev && next && next.is_enabled && minutesBetween(prev.scheduled_at, next.scheduled_at) !== 0) out.push({ kind, from: prev.scheduled_at, to: next.scheduled_at });
  }
  return out;
}

// 늦춰지는 알람이 있어 확인이 먼저인가 (앞당김 · 5분 미만 늦춤은 바로 저장). 앱 가짜 모드 updateAppointment의 needsConfirm과 같은 조건
//   L6 안건후보: 서버 needs_confirm 경계 기본안 = 고치는 일정 자신의 알람이 5분 이상 늦춰질 때 (앱 CONFIRM_MOVE_MINUTES와 같은 값). 다른 일정의 기상 재판정은 묻지 않음
export function needsConfirm(changes: readonly AlarmChangeLine[]): boolean {
  return changes.some((c) => minutesBetween(c.from, c.to) >= CONFIRM_MOVE_MINUTES);
}

// ---------------------------------------------------------------------------
// 이후 모두 — 지울 뒤 회차
// ---------------------------------------------------------------------------

export type SeriesRow = {
  appointment_id: string;
  occurrence_on: string;
  appointment_at: string;
  exception_kind: ExceptionKind | null;
};

// 이 회차보다 뒤(occurrence_on)의 회차 중 지울 것. 지난 회차(약속 시각이 지금 이전)와 출발 · 도착 기록이 있는 회차는 기록으로 남김
//   · 이후 모두 고치기(mode EDIT)는 이번만 고친 · 지운 회차(예외)도 남김 — 사용자가 따로 손댄 회차이고 날짜 자리도 그대로여야 roll이 다시 안 만듦
//   · 이후 모두 지우기(mode DELETE)는 예외 회차도 지움 (이 회차부터 반복이 끝남)
//   L6 안건후보: 이후 모두 고치기에서 예외 회차 기본안 = 남김 (이번만 고친 값이 이후 모두에 덮이지 않음)
export function laterRowsToDelete(args: { rows: readonly SeriesRow[]; target: Pick<SeriesRow, 'appointment_id' | 'occurrence_on'>; now: Date; recordIds: ReadonlySet<string>; mode: 'EDIT' | 'DELETE' }): string[] {
  return args.rows
    .filter(
      (r) =>
        r.appointment_id !== args.target.appointment_id &&
        r.occurrence_on > args.target.occurrence_on &&
        Date.parse(r.appointment_at) > args.now.getTime() &&
        !args.recordIds.has(r.appointment_id) &&
        (args.mode === 'DELETE' || r.exception_kind == null),
    )
    .map((r) => r.appointment_id);
}

// ---------------------------------------------------------------------------
// 7.1.3 재평가 — 그날 첫 일정만 기상
// ---------------------------------------------------------------------------

// 그날 내 약속 한 줄이 가진 기상 알람 (wakeEnabled: null = 기상 알람이 없음)
export type DayWakeRow = { id: string; at: Date; wakeEnabled: boolean | null };

// 같은 날 약속들을 hasEarlierWake(calc/wake.ts — 서버 plan.ts · 앱 목업과 같은 판정)에 넘길 모양으로. 기상 알람이 없는 약속은 기상을 안 가짐
export function wakesOfRows(rows: readonly DayWakeRow[]): SameDayWake[] {
  return rows.flatMap((r) => (r.wakeEnabled == null ? [] : [{ appointmentId: r.id, appointmentAt: r.at, isEnabled: r.wakeEnabled }]));
}

// 고치기 · 지우기 전(beforeWakes)과 지금까지 다시 판정한 결과(sim) 기준으로, 이 약속의 기상을 어떻게 할지
//   · 전에는 앞 기상에 밀려 기상이 없었는데(displaced) 이제 앞 기상이 없고 기상 알람도 없음 → ADD (첫 일정이 지워지면 둘째 일정에 기상)
//   · 전에는 첫 일정이라 기상이 있었는데 이제 앞 기상이 생김 → REMOVE (앞 일정이 새로 생기거나 시각이 앞으로 옮겨짐)
//   · 그 밖은 NONE — 사용자가 일부러 기상을 안 만든 약속(밀려서가 아님)을 멋대로 되살리지 않음
//   · 이미 울린 기상 알람(wakeRung = 울릴 시각이 지남)은 떼지 않음 → NONE. 울린 기록(미루기 · 끄기)이 학습 · 미루기 판정의 근거라, 알람을 지우면 그 기록도 사라짐 (헤드 확정)
//   earlierAfter = 지금 기준으로 앞 기상이 있는지 (다시 계산할 때 sameDayWake로 넘김)
export function wakeAction(args: { id: string; at: Date; hasWake: boolean; wakeRung?: boolean; beforeWakes: readonly SameDayWake[]; sim: readonly SameDayWake[] }): { action: 'ADD' | 'REMOVE' | 'NONE'; earlierAfter: boolean } {
  const displacedBefore = hasEarlierWake(args.at, args.beforeWakes, args.id);
  const earlierAfter = hasEarlierWake(args.at, args.sim, args.id);
  if (displacedBefore && !earlierAfter && !args.hasWake) return { action: 'ADD', earlierAfter };
  if (!displacedBefore && earlierAfter && args.hasWake && !args.wakeRung) return { action: 'REMOVE', earlierAfter };
  return { action: 'NONE', earlierAfter };
}

// 같은 날 약속을 시각 순(같으면 id 순)으로
export const byTimeThenId = (a: { at: Date; id: string }, b: { at: Date; id: string }) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// 기준 회차 고르기 (alarm-roll 본인 길이 씀 — DB 함수 roll_due_series의 base_appointment와 같은 규칙)
// ---------------------------------------------------------------------------

// 묶음의 기준 회차 = 예외 아닌 회차 중 occurrence_on이 가장 늦은 행. 없으면 이번만 고친(EDITED) 행 중 가장 늦은 것(예외뿐인 묶음이 멈추지 않게). 지운(CANCELED) 회차는 기준이 아님(알람이 없어 이어받을 것이 없음)
export function pickBaseRow<T extends { occurrence_on: string; appointment_at: string; appointment_id: string; exception_kind?: ExceptionKind | null }>(rows: readonly T[]): T | null {
  const usable = rows.filter((r) => r.exception_kind !== 'CANCELED');
  const rank = (r: T) => (r.exception_kind == null ? 0 : 1);
  const sorted = [...usable].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.occurrence_on < b.occurrence_on ? 1 : a.occurrence_on > b.occurrence_on ? -1 : 0) ||
      Date.parse(b.appointment_at) - Date.parse(a.appointment_at) ||
      (a.appointment_id < b.appointment_id ? -1 : a.appointment_id > b.appointment_id ? 1 : 0),
  );
  return sorted[0] ?? null;
}
