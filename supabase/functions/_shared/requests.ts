// alarm-suggest · alarm-commit 요청 읽기 (순수 · node --test). 필드 이름은 상세설계서 5장 5.4.1 · 5.4.2를 따름
import type { EditInput } from './commit-core.ts';
import { IMPORTANCES, readAlarmFields, readParticipantFields, readPlace, readRecurrence, type AlarmFields } from './draft.ts';
import type { PlanDraft } from './plan-core.ts';
import type { Reader } from './read.ts';

// ---- alarm-suggest (5.4.1) ----
//   appointment_id(선택, 기존 약속 기준) · appointment_at · origin{name,lat,lng} · destination{name,lat,lng} · transport_type · importance
//   · buffer_minutes · prepare_minutes_override · travel_minutes_override(MANUAL) · before_prepare_minutes · with_wake
//   · kinds · enabled · manual_times · levels
export function readSuggestRequest(r: Reader): PlanDraft {
  const appointmentId = r.uuid('appointment_id');
  // 기존 약속이면 시각 · 장소 · 중요도는 DB 값을 쓰므로 요청 값은 읽지 않음 (D41)
  const at = appointmentId ? undefined : r.date('appointment_at', { required: true });
  const destination = appointmentId ? undefined : readPlace(r, 'destination', { required: true, nameRequired: true });
  const importance = appointmentId ? undefined : r.oneOf('importance', IMPORTANCES);
  const prepareMinutes = r.int('prepare_minutes_override', { min: 0, max: 600 });
  const travelMinutes = r.int('travel_minutes_override', { min: 0, max: 600 });
  return {
    ...(appointmentId ? { appointmentId } : {}),
    ...(at ? { at } : {}),
    ...(destination ? { destination } : {}),
    ...(importance ? { importance } : {}),
    ...(prepareMinutes != null ? { prepareMinutes } : {}),
    ...(travelMinutes != null ? { travelMinutes, travelSource: 'MANUAL' as const } : {}),
    ...readParticipantFields(r),
    ...readAlarmFields(r),
  };
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

  // 약속 알람: 새 약속(appointment) 또는 기존 약속(appointment_id) 중 하나
  const appointmentId = r.uuid('appointment_id');
  const rawNew = r.object('appointment');
  if (appointmentId && rawNew) r.problemAt('appointment', 'appointment_id와 같이 쓸 수 없어요 (일정 제목 · 시각 · 장소는 여기서 고치지 않아요)');
  if (!appointmentId && !rawNew) r.problemAt('appointment_id', 'appointment_id 또는 appointment가 필요해요');

  let appointment: NewAppointment | undefined;
  let at: Date | undefined;
  let destination: PlanDraft['destination'];
  let importance: PlanDraft['importance'];
  if (rawNew && !appointmentId) {
    const title = rawNew.string('title', { required: true, min: 1, max: 100 });
    at = rawNew.date('appointment_at', { required: true });
    destination = readPlace(rawNew, 'destination', { required: true, nameRequired: true });
    importance = rawNew.oneOf('importance', IMPORTANCES);
    const groupId = rawNew.uuid('group_id');
    const recurrenceRule = readRecurrence(rawNew);
    if (title) appointment = { title, ...(groupId ? { groupId } : {}), ...(recurrenceRule !== undefined ? { recurrenceRule } : {}) };
  }

  // participant{origin, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes} (+ before_prepare_minutes · with_wake)
  const p = r.object('participant');
  let participantFields: Pick<PlanDraft, 'origin' | 'transport' | 'bufferMinutes' | 'beforePrepareMinutes' | 'withWake'> = {};
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
  return { type: 'APPOINTMENT', draft, appointment, replaceExisting: r.bool('replace_existing') ?? true, edits };
}
