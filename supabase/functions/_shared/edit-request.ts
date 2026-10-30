// appointment-edit 요청 읽기 (순수 · node --test) — 모양이 틀리면 VALIDATION_FAILED(400) + details.issues (read.ts)
// 앱 가짜 모드(mobile/src/features/alarm/api.ts)의 네 함수와 하나씩 맞음. 이름은 서버 규칙(snake_case · DB와 같은 값 이름)이고,
//   앱 AppointmentPatch(title · at · place · placeLat · placeLng · importance · repeatDays)는 4c(realEdit.ts)가 옮겨 담음: at → appointment_at, place · placeLat · placeLng → destination, repeatDays → repeatToRrule(…) = recurrence_rule
//
//   { action: 'UPDATE', appointment_id, scope?, patch: { title?, appointment_at?, destination?: { name, lat?, lng? }, importance?, recurrence_rule? (null = 반복 끔) }, confirmed? }
//   { action: 'DELETE', appointment_id, scope? }
//   { action: 'RESTORE', appointment_id }     이미 지운 뒤의 되돌리기 (이번만 지운 회차만 — edit-run.ts)
//   { action: 'LEAVE', appointment_id }       공동 약속에서 나만 빠지기
//   scope: 'this' | 'following' (앱 EditScope와 같은 글자, 안 보내면 'this'). 반복이 아니면 둘 다 그 일정 하나
//   confirmed: 확인 시트에서 "바꾸기"를 눌렀거나 되돌리기처럼 확인 없이 바로 저장 (앱 UpdateOptions.confirmed) — 아니면 늦춰지는 알람이 있을 때 저장하지 않고 needs_confirm으로 돌려줌
import { EDIT_SCOPES, type AppointmentPatch, type EditScope } from './edit.ts';
import { IMPORTANCES, readPlace, readRecurrence } from './draft.ts';
import type { Reader } from './read.ts';

export const EDIT_ACTIONS = ['UPDATE', 'DELETE', 'RESTORE', 'LEAVE'] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export type EditRequest =
  | { action: 'UPDATE'; appointmentId: string; scope: EditScope; patch: AppointmentPatch; confirmed: boolean }
  | { action: 'DELETE'; appointmentId: string; scope: EditScope }
  | { action: 'RESTORE'; appointmentId: string }
  | { action: 'LEAVE'; appointmentId: string };

function readPatch(r: Reader): AppointmentPatch {
  const p = r.object('patch', { required: true });
  if (!p) return {};
  const title = p.string('title', { min: 1, max: 100 });
  const at = p.date('appointment_at');
  const destination = readPlace(p, 'destination', { nameRequired: true });
  const importance = p.oneOf('importance', IMPORTANCES);
  const recurrenceRule = readRecurrence(p);
  return {
    ...(title !== undefined ? { title } : {}),
    ...(at ? { at } : {}),
    ...(destination?.name ? { destination: { name: destination.name, ...(destination.lat != null && destination.lng != null ? { lat: destination.lat, lng: destination.lng } : {}) } } : {}),
    ...(importance ? { importance } : {}),
    ...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
  };
}

export function readEditRequest(r: Reader): EditRequest {
  const action = r.oneOf('action', EDIT_ACTIONS, { required: true });
  const appointmentId = r.uuid('appointment_id', { required: true });
  const scope = r.oneOf('scope', EDIT_SCOPES) ?? 'this';
  // 이 함수는 읽기만 하고, 필수 값이 없으면 부르는 쪽(r.finish())에서 던짐. 아래 id는 그때 안 쓰이는 자리표시
  const id = appointmentId ?? '';
  switch (action) {
    case 'UPDATE':
      return { action, appointmentId: id, scope, patch: readPatch(r), confirmed: r.bool('confirmed') ?? false };
    case 'DELETE':
      return { action, appointmentId: id, scope };
    case 'RESTORE':
      return { action, appointmentId: id };
    case 'LEAVE':
      return { action, appointmentId: id };
    default:
      return { action: 'LEAVE', appointmentId: id }; // action이 틀렸거나 없음 — 문제는 이미 기록됨
  }
}
