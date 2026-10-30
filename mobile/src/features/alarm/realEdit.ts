// ① 일정 수정 · 삭제 — 실데이터 (이슈 #211 D41 A, 4c 이슈 #282). 서버 함수 `appointment-edit`(supabase/functions/_shared/edit-request.ts · edit-run.ts)에 네 함수를 연결
//   · 요청: 앱 AppointmentPatch → 서버 patch로 이름만 옮김 (at → appointment_at, place · placeLat · placeLng → destination, repeatDays → recurrence_rule). scope 글자(this · following)는 앱과 서버가 같음
//   · 응답: 모든 성공 응답이 { ring_packages, canceled_alarm_ids }를 가짐(alarm-commit과 같은 모양) → 기존 applyCommit으로 폰 예약에 그대로 반영
//   · 확인(needsConfirm)은 서버 needs_confirm만 믿음 — 서버는 고치는 일정 자신의 알람이 5분 이상 늦춰질 때만 묻고(D67), 앱 schedule.ts needsMoveConfirm(앞당김도 묻는 옛 규칙)은 이 길에서 안 씀
//   · 삭제: 앱이 5초 토스트 뒤(또는 화면을 떠날 때) deleteAppointment를 부름 — 5초 안에 되돌리면 안 부름. restoreAppointment는 이미 지운 뒤의 되돌리기 (서버: 이번만 지운 회차만 되살림)
//   · 오류: 서버 코드 · details.reason을 사용자 문구로 (editError). 네트워크 · 시간 초과 등은 lib/edge가 이미 한국어 문구의 EdgeError로 던지므로 그대로
//   · 쓰기는 자동 재시도하지 않음 (realPlan.ts와 같은 방침). 서버가 같은 요청을 두 번 받아도 같은 결과로 끝나게 만들어져 있어 사용자가 다시 눌러도 안전
import { applyCommit, syncNow } from '@/lib/alarmSync';
import { parseDbTime } from '@/lib/dbTime';
import { callEdge, EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

import { forgetDetail } from './detailCache';
import { repeatToRrule } from './repeat';
import type { AlarmChange, AlarmKind, AppointmentPatch, EditScope, UpdateOptions, UpdateResult } from './types';

const EDIT_TIMEOUT_MS = 30_000; // 장소를 바꾸면 서버가 카카오 길찾기를 불러서 읽기보다 오래 걸릴 수 있음 (alarm-commit과 같음)

const warnDev = (what: string, e: unknown) => {
  if (__DEV__) console.warn(`[alarm] ${what}`, e);
};

// ---------------------------------------------------------------------------
// 요청 만들기 (순수)
// ---------------------------------------------------------------------------

export type EditPatchBody = {
  title?: string;
  appointment_at?: string;
  destination?: { name: string; lat?: number; lng?: number };
  importance?: AppointmentPatch['importance'];
  recurrence_rule?: string | null; // null = 반복 끔
};

// 앱 AppointmentPatch → 서버 patch. 안 넣은 칸은 보내지 않음 (서버는 없는 칸 = 그대로)
//   · 제목 · 장소가 비었으면 서버가 VALIDATION_FAILED로 거절하므로 보내기 전에 이유를 알려 줌 (제목은 가짜 모드 api.ts와 같은 문구)
//   · 좌표는 위도 · 경도가 둘 다 있을 때만 (서버는 둘이 같이 있어야 함). 이름만 있으면 서버가 옛 좌표를 비움 → 길찾기를 새로 구하거나 근사값으로
//   · repeatDays: 빈 목록 = 반복 끔(null), 요일이 있으면 RRULE. 서버가 범위(이번만이면 무시 등)에 맞춰 읽음
export function toEditPatch(patch: AppointmentPatch): EditPatchBody {
  const body: EditPatchBody = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new UserError('일정 이름을 입력해 주세요');
    body.title = title;
  }
  if (patch.at) body.appointment_at = patch.at.toISOString();
  if (patch.place !== undefined) {
    const name = patch.place.trim();
    if (!name) throw new UserError('장소를 골라 주세요');
    const { placeLat: lat, placeLng: lng } = patch;
    body.destination = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { name, lat, lng } : { name };
  }
  if (patch.importance) body.importance = patch.importance;
  if (patch.repeatDays) body.recurrence_rule = repeatToRrule(patch.repeatDays);
  return body;
}

export const updateBody = (id: string, patch: AppointmentPatch, scope: EditScope, confirmed: boolean) => ({
  action: 'UPDATE' as const,
  appointment_id: id,
  scope,
  patch: toEditPatch(patch),
  ...(confirmed ? { confirmed: true } : {}),
});

// ---------------------------------------------------------------------------
// 응답 읽기 (순수)
// ---------------------------------------------------------------------------

// 모든 성공 응답이 가진 칸 중 쓰는 것 — applyCommit이 읽는 두 칸 + 지워진 약속 id(H03 기억 비우기)
type EditCommon = {
  ring_packages?: Parameters<typeof applyCommit>[0]['ring_packages'];
  canceled_alarm_ids?: string[] | null;
  deleted_appointment_ids?: string[] | null;
};

export type EditUpdateResponse = EditCommon & {
  saved: boolean;
  needs_confirm: boolean;
  changes?: { kind: AlarmKind; from: string; to: string }[] | null;
};
export type EditDeleteResponse = EditCommon & { deleted: boolean; mode?: string };
export type EditRestoreResponse = EditCommon & { restored: boolean; reason?: 'NOT_FOUND' | 'NOT_DELETED' };
export type EditLeaveResponse = EditCommon & { left: boolean };

// 서버 changes(시각은 ISO 글자) → 앱 AlarmChange(Date)
export function toAlarmChanges(changes: EditUpdateResponse['changes']): AlarmChange[] {
  return (changes ?? []).map((c) => ({ kind: c.kind, from: parseDbTime(c.from), to: parseDbTime(c.to) }));
}

// ---------------------------------------------------------------------------
// 오류 문구
// ---------------------------------------------------------------------------

// UNPROCESSABLE의 details.reason별 문구. 출발 시각 지남 · 순서 어긋남(DEPARTURE_PASSED · ORDER) · 지난 시각(PAST_TIME)은 lib/edge의 문구를 그대로 씀
const EDIT_REASONS: Record<string, string> = {
  GROUP_EDIT_LIMIT: '공동 약속의 시각 · 장소 · 반복은 아직 고칠 수 없어요. 지우고 다시 만들어 주세요',
  HAS_RECORDS: '출발 · 도착 기록이 있는 일정은 지우거나 빠질 수 없어요',
  NOT_SHARED: '공동 약속이 아니에요',
  CREATOR_CANNOT_LEAVE: '내가 만든 공동 약속은 빠질 수 없어요. 지워 주세요',
  TRAVEL_REQUIRED: '이동시간을 알 수 없어 알람을 다시 만들지 못했어요. 장소를 검색해서 골라 주세요',
};

const EDIT_CODES: Partial<Record<EdgeError['code'], string>> = {
  NOT_FOUND: '일정을 찾을 수 없어요. 이미 지워졌을 수 있어요',
  FORBIDDEN: '공동 약속은 만든 사람만 고치거나 지울 수 있어요. "나는 빠지기"를 써 주세요',
  // 고치기 화면에는 이동시간 직접 입력 칸이 없어 lib/edge의 "직접 입력해 주세요" 문구는 맞지 않음
  ROUTE_UNAVAILABLE: '새 장소까지 이동시간을 구하지 못했어요. 장소를 검색해서 골라 주세요',
};

// 서버가 준 오류를 사용자에게 보여 줄 UserError로. 이 표에 없는 것은 lib/edge가 만든 문구(일반 오류 · 네트워크 등)를 그대로
export function editError(e: unknown): unknown {
  if (!(e instanceof EdgeError)) return e;
  if (e.code === 'UNPROCESSABLE') {
    const reason = (e.details as { reason?: unknown } | null | undefined)?.reason;
    const message = typeof reason === 'string' ? EDIT_REASONS[reason] : undefined;
    return message ? new UserError(message) : e;
  }
  const message = EDIT_CODES[e.code];
  return message ? new UserError(message) : e;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  try {
    return await callEdge<T>('appointment-edit', body, { timeoutMs: EDIT_TIMEOUT_MS });
  } catch (e) {
    throw editError(e);
  }
}

// ---------------------------------------------------------------------------
// 저장 뒤처리
// ---------------------------------------------------------------------------

// 서버에 저장은 끝났음 — 폰 예약 반영이 실패해도 실패로 돌리지 않음 (realPlan.ts createAppointment와 같은 방침): 오류 토스트가 뜨면 저장된 줄 모르고 다시 누르게 됨.
//   폰 예약은 다음 맞추기(reconcile)가 서버 값으로 다시 걸어 줌.
//   뒤이어 syncNow를 한 번 부름 (기다리지 않음 · 던지지 않음): 서버가 이미 커밋했는데 응답이 유실된 재시도에서는 "변경 없음 · 이미 지움" 응답이 ring_packages: []로 와서
//   폰에 옛 예약이 남을 수 있기 때문 — 서버 상태를 기준으로 폰을 맞춤
//   L6 안건후보: 수정 · 삭제 응답 뒤 맞추기 기본안 = 모든 성공 응답(변경 없음 포함) 뒤에 syncNow 한 번 (기다리지 않음)
async function afterSaved(res: EditCommon, id: string): Promise<void> {
  for (const gone of new Set([id, ...(res.deleted_appointment_ids ?? [])])) forgetDetail(gone);
  try {
    const summary = await applyCommit({ ring_packages: res.ring_packages ?? [], canceled_alarm_ids: res.canceled_alarm_ids ?? [] });
    if (summary.failed.length) warnDev('폰에 못 건 알람', summary.failed);
  } catch (e) {
    warnDev('저장 뒤처리 실패 (폰 예약)', e);
  }
  void Promise.resolve()
    .then(() => syncNow())
    .catch((e: unknown) => warnDev('저장 뒤 맞추기 실패', e));
}

// ---------------------------------------------------------------------------
// 네 함수 (api.ts가 실서버 모드에서 넘겨 줌)
// ---------------------------------------------------------------------------

// 일정 고치기 — needsConfirm이면 서버가 저장하지 않고 돌려준 것: 화면이 확인 시트로 묻고 { confirmed: true }로 같은 값을 다시 부름. 저장됐으면 changes는 시각이 바뀐 기상 · 준비 · 출발
export async function updateAppointment(id: string, patch: AppointmentPatch, scope: EditScope, options: UpdateOptions = {}): Promise<UpdateResult> {
  const res = await call<EditUpdateResponse>(updateBody(id, patch, scope, options.confirmed === true));
  const changes = toAlarmChanges(res.changes);
  if (res.needs_confirm && !res.saved) return { changes, needsConfirm: true };
  await afterSaved(res, id);
  return { changes, needsConfirm: false };
}

// 일정 지우기 — 반복이면 this = 이번 회차만(서버가 행은 두고 알람만 지움), following = 이번 회차와 그 뒤 모두. 이미 지워졌어도(NONE) 성공
export async function deleteAppointment(id: string, scope: EditScope): Promise<void> {
  const res = await call<EditDeleteResponse>({ action: 'DELETE', appointment_id: id, scope });
  await afterSaved(res, id);
}

// 이미 지운 뒤의 되돌리기 — 서버는 이번만 지운 회차(행이 남아 있음)만 되살림. 한 번짜리 · 이후 모두 지우기는 행 자체를 지워서 못 되살림(restored false) → 안내만
//   NOT_DELETED는 이미 되살렸거나 지운 적 없는 일정(같은 요청을 두 번 보낸 경우) → 성공으로 두고 맞추기만 함
//   L6 안건후보: 되돌리기 못 하는 경우 기본안 = 안내만 (지우기 전 값을 들고 alarm-commit으로 다시 만드는 안은 11/10 뒤)
export async function restoreAppointment(id: string): Promise<void> {
  const res = await call<EditRestoreResponse>({ action: 'RESTORE', appointment_id: id });
  if (!res.restored && res.reason !== 'NOT_DELETED') throw new UserError('이 일정은 되돌릴 수 없어요. 새로 만들어 주세요');
  await afterSaved(res, id);
}

// 공동 약속에서 나만 빠지기 — 서버가 내 참여 · 알람만 지움. left false는 이미 빠졌거나 내게 안 보이는 일정이라 성공으로 두고 맞추기만 함
export async function leaveSharedAppointment(id: string): Promise<void> {
  const res = await call<EditLeaveResponse>({ action: 'LEAVE', appointment_id: id });
  await afterSaved(res, id);
}
