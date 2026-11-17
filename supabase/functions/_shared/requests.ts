// alarm-suggest · alarm-commit 요청 읽기 (순수 · node --test). 둘이 같은 초안 모양을 받음 — 필드 이름은 상세설계서 5장 5.4.2를 따름
import { autoImportance } from './calc/importance.ts';
import type { EditInput } from './commit-core.ts';
import { IMPORTANCES, readAlarmFields, readParticipantFields, readPlace, readRecurrence, type AlarmFields } from './draft.ts';
import type { PlanDraft } from './plan-core.ts';
import type { Reader } from './read.ts';

// ---- 약속 알람 초안 — alarm-suggest(5.4.1)와 alarm-commit(5.4.2)이 같은 모양으로 받음 (계획 7절 "alarm-commit 입력 = H05 초안 모양 그대로 + 기존 약속 id") ----
//   appointment_id(기존 약속) 또는 appointment{ title, appointment_at, destination{name,lat,lng,radius_m(선택, 100~500)}, importance, group_id, recurrence_rule }(새 약속)
//   participant{ origin, transport_type, est_travel_minutes + travel_source(API · MANUAL), prepare_minutes, buffer_minutes, before_prepare_minutes, with_wake }
//   + 루트의 kinds · enabled · manual_times · levels
//   앱은 H05 초안 하나를 두 함수에 그대로 보내면 됨. 미리 보기에는 title · group_id · recurrence_rule · replace_existing · edits가 필요 없어 읽기만 하고 안 씀
//   (옛 alarm-suggest 모양 — 루트의 appointment_at · destination · travel_minutes_override 같은 칸 — 은 받지 않음. 부르는 곳이 아직 없어서 하나로)
//   titleRequired: 저장할 때(alarm-commit)만 새 약속의 제목이 필수
function readAppointmentDraft(r: Reader, opts: { titleRequired: boolean }): { draft: PlanDraft; appointment?: NewAppointment } {
  const appointmentId = r.uuid('appointment_id');
  const rawNew = r.object('appointment');
  if (appointmentId && rawNew) r.problemAt('appointment', 'appointment_id와 같이 쓸 수 없어요 (일정 제목 · 시각 · 장소는 여기서 고치지 않아요)');
  if (!appointmentId && !rawNew) r.problemAt('appointment_id', 'appointment_id 또는 appointment가 필요해요');

  let appointment: NewAppointment | undefined;
  let at: Date | undefined;
  let destination: PlanDraft['destination'];
  let importance: PlanDraft['importance'];
  if (rawNew && !appointmentId) {
    const title = rawNew.string('title', { required: opts.titleRequired, min: 1, max: 100 });
    at = rawNew.date('appointment_at', { required: true });
    destination = readPlace(rawNew, 'destination', { required: true, nameRequired: true, radius: true });
    // 고르지 않았으면 제목으로 자동 (시험 · 면접만 HIGH, 나머지 LOW) — 직접 고른 값이 이김
    importance = rawNew.oneOf('importance', IMPORTANCES) ?? (title ? autoImportance(title) : undefined);
    const groupId = rawNew.uuid('group_id');
    const recurrenceRule = readRecurrence(rawNew);
    if (title) appointment = { title, ...(groupId ? { groupId } : {}), ...(recurrenceRule !== undefined ? { recurrenceRule } : {}) };
  }

  // participant{origin, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes} (+ before_prepare_minutes · with_wake)
  const p = r.object('participant');
  let participantFields: Pick<PlanDraft, 'origin' | 'transport' | 'bufferMinutes' | 'beforePrepareMinutes' | 'withWake' | 'activities'> = {};
  let travelMinutes: number | undefined;
  let travelSource: 'API' | 'MANUAL' | undefined;
  let prepareMinutes: number | undefined;
  if (p) {
    participantFields = readParticipantFields(p);
    travelMinutes = p.int('est_travel_minutes', { min: 0, max: 600 });
    // CACHED(같은 경로 실측 중앙값)는 D5가 열려 있어 저장하지 않음 — 보여 준 값을 저장하려면 사용자가 확인한 값으로 MANUAL
    // ESTIMATE(직선거리 근사값)도 확인한 값으로 MANUAL (7장 7.1.2 단계 4)
    travelSource = p.oneOf('travel_source', ['API', 'MANUAL'] as const);
    prepareMinutes = p.int('prepare_minutes', { min: 0, max: 600 });
    if (travelMinutes != null && !travelSource) p.problemAt('travel_source', 'est_travel_minutes와 같이 API · MANUAL 중 하나를 보내 주세요');
    if (travelSource && travelMinutes == null) p.problemAt('est_travel_minutes', 'travel_source와 같이 보내 주세요');
  }

  const draft: PlanDraft = {
    ...(appointmentId ? { appointmentId } : {}),
    ...(at ? { at } : {}),
    ...(destination ? { destination } : {}),
    ...(importance ? { importance } : {}),
    ...participantFields,
    ...(travelMinutes != null ? { travelMinutes, travelSource } : {}),
    ...(prepareMinutes != null ? { prepareMinutes } : {}),
    ...readAlarmFields(r),
  };
  // 반복 + 할 일은 받지 않음 — 할 일은 그날 시각(절대 시각)이라 다음 회차에 옮길 규칙이 아직 없음 (있는 반복 일정은 plan-core가 RECURRING으로 막음)
  if (appointment?.recurrenceRule && participantFields.activities?.length) r.problemAt('participant.activities', '반복 일정에는 할 일을 넣을 수 없어요');
  return { draft, appointment };
}

// ---- alarm-suggest (5.4.1) — 미리 보기 ----
export function readSuggestRequest(r: Reader): PlanDraft {
  return readAppointmentDraft(r, { titleRequired: false }).draft;
}

// ---- alarm-commit (5.4.2) ----

export type NewAppointment = {
  title: string;
  groupId?: string;
  recurrenceRule?: string | null; // D44 — 첫 회차만 알람을 만듦 (D4)
};

export type StandaloneInput = {
  alarmId?: string; // 있으면 고치기
  scheduledAt?: Date; // 만들 때 필수
  recurrenceRule?: string | null;
  isEnabled?: boolean;
  levels?: AlarmFields['levels'];
};

export type CommitRequest =
  | {
      type: 'APPOINTMENT';
      draft: PlanDraft;
      appointment?: NewAppointment; // 없으면 draft.appointmentId의 기존 약속
      replaceExisting: boolean;
      edits: EditInput[];
    }
  | { type: 'STANDALONE'; alarm: StandaloneInput; edits: EditInput[] };

const SCREENS = ['H03', 'H05', 'S01'] as const;
const ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE', 'ROUTINE'] as const;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

function readEdits(r: Reader): EditInput[] {
  const items = r.objects('edits', { max: 50 }) ?? [];
  return items.flatMap((e) => {
    const screen = e.oneOf('screen', SCREENS, { required: true });
    const field = e.string('field', { required: true, max: 40, pattern: FIELD_NAME });
    const alarmType = e.oneOf('alarm_type', ALARM_TYPES);
    const autoValue = e.json('auto_value');
    const editedValue = e.json('edited_value');
    if (!screen || !field) return [];
    return [{ screen, field, ...(alarmType ? { alarmType } : {}), autoValue, editedValue }];
  });
}

export function readCommitRequest(r: Reader): CommitRequest {
  const type = r.oneOf('type', ['APPOINTMENT', 'STANDALONE'] as const) ?? 'APPOINTMENT';
  const edits = readEdits(r);

  if (type === 'STANDALONE') {
    // 일정 없는 알람 (D46 · Q10 B): 시각 + 반복만. 알람 종류는 기상(소리) 고정, 이름은 '알람' 고정 (F4 ②)
    const a = r.object('alarm', { required: true });
    if (!a) return { type, alarm: {}, edits };
    const alarmId = a.uuid('alarm_id');
    const scheduledAt = a.date('scheduled_at', { required: !alarmId });
    const recurrenceRule = readRecurrence(a);
    const isEnabled = a.bool('is_enabled');
    const levels = readAlarmFields(a).levels;
    return {
      type,
      alarm: {
        ...(alarmId ? { alarmId } : {}),
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
        ...(isEnabled != null ? { isEnabled } : {}),
        ...(levels ? { levels } : {}),
      },
      edits,
    };
  }

  // 약속 알람: 새 약속(appointment) 또는 기존 약속(appointment_id) 중 하나 — alarm-suggest와 같은 초안 모양
  const { draft, appointment } = readAppointmentDraft(r, { titleRequired: true });
  return { type: 'APPOINTMENT', draft, appointment, replaceExisting: r.bool('replace_existing') ?? true, edits };
}
