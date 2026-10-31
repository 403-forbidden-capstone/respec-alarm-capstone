// alarm-commit이 DB에 쓰는 부분 — 쓰기는 service_role 클라이언트로, 읽기는 부른 사람의 RLS 클라이언트로.
// Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (commit.test.ts). 어떤 행을 쓸지는 commit-core.ts(순수)가 정함
// supabase-js에는 트랜잭션이 없어 순서(약속 → 참여 조건 → 알람 → 고친 값 기록)대로 쓰고, 이번 호출이 새로 만든 약속 · 참여 조건은
// 중간에 실패하면 지워서(CASCADE) 되돌림. 같은 요청을 다시 보냈을 때 같은 상태가 되는 건 기존 약속(appointment_id)이 있을 때만 —
// 새 약속(appointment)은 응답만 잃고 다시 보내면 약속 · 알람이 두 벌 생기고, 일정 없는 알람도 alarm_id 없이 다시 보내면 하나 더 생김 (요청 키는 아직 안 받음).
// 근본 해결은 DB 함수(RPC)로 묶는 것
import { autoLevel, resolveIntensity, wakeSensitivityOf } from './calc/index.ts';
import { buildEditLogRows, diffAlarms, type AlarmWrite, type EditInput } from './commit-core.ts';
import { must } from './db.ts';
import { HttpError } from './errors.ts';
import { resolveOverrides, type AlarmRow, type AppointmentRow, type Plan, type PlanDraft, type PlanInputs } from './plan-core.ts';
import { loadProfile } from './plan.ts';
import type { NewAppointment, StandaloneInput } from './requests.ts';
import { buildRingPackages, canceledAlarmIds, subtitleFor } from './ring-package.ts';
import type { Db } from './supabase.ts';

export type CommitCtx = {
  userId: string;
  userDb: Db; // 부른 사람의 RLS 클라이언트 (읽기)
  service: Db; // service_role (쓰기)
  now: Date;
};

export const ALARM_COLUMNS =
  'alarm_id, participant_id, user_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, snooze_limit, time_source, intensity_source, recurrence_rule';
const APPOINTMENT_COLUMNS = 'appointment_id, creator_id, group_id, title, appointment_at, dest_name, dest_lat, dest_lng, importance, recurrence_rule';

// 응답에 싣는 알람 요약
export const summarize = (a: AlarmRow) => ({
  alarm_id: a.alarm_id,
  alarm_type: a.alarm_type,
  scheduled_at: a.scheduled_at,
  is_enabled: a.is_enabled,
  intensity: a.intensity,
  voice_tone: a.voice_tone,
  sound_key: a.sound_key,
  vibration: a.vibration,
  time_source: a.time_source,
  intensity_source: a.intensity_source,
  recurrence_rule: a.recurrence_rule,
});

async function saveEditLogs(ctx: CommitCtx, appointmentId: string | null, alarms: readonly AlarmRow[], edits: readonly EditInput[]) {
  if (!edits.length) return;
  must('user_edit_logs', await ctx.service.from('user_edit_logs').insert(buildEditLogRows(ctx.userId, appointmentId, alarms, edits)));
}

// 저장해도 되는 계획인지 — 아니면 사용자에게 보일 오류로
//   · 이동시간은 길찾기 값(API)이나 사용자가 정한 값(MANUAL)만 저장. 서버가 대신 구한 같은 경로 중앙값(CACHED)은 D5가 열려 있어 쓰지 않고,
//     직선거리 근사값(ESTIMATE)은 사용자가 확인해야 하므로 확인한 값을 MANUAL로 다시 보내게 함 (7장 7.1.2 단계 4)
//   · 출발 시각까지 지났거나 알람 순서가 어긋나면 UNPROCESSABLE (8장 8.2.1)
export function assertPersistable(plan: Plan): void {
  const travel = plan.travel.chosen;
  if (!travel || (travel.source !== 'API' && travel.source !== 'MANUAL')) {
    throw new HttpError('ROUTE_UNAVAILABLE', '길찾기 값을 못 구해서 저장하지 못했어요. 이동시간을 확인하고 직접 입력해 주세요', {
      manual_required: true,
      fallback: travel ? { minutes: travel.minutes, source: travel.source, needs_confirmation: travel.needsConfirmation, sample_count: travel.sampleCount ?? null } : null,
      warnings: plan.travel.warnings,
    });
  }
  if (!plan.check.ok) {
    throw new HttpError('UNPROCESSABLE', plan.check.message, { reason: plan.check.reason, ...(plan.check.detail ?? {}) });
  }
}

// ---------------------------------------------------------------------------
// 약속 알람
// ---------------------------------------------------------------------------

export async function persistAppointment(
  ctx: CommitCtx,
  args: {
    plan: Plan;
    inputs: PlanInputs;
    created?: NewAppointment; // 새 약속이면 (기존 약속이면 없음 — 기존 약속은 안 고침, D41)
    draft: PlanDraft;
    replaceExisting: boolean;
    edits: readonly EditInput[];
    timeZone: string;
  },
) {
  assertPersistable(args.plan);
  const { service, userId, now } = ctx;
  const { plan, inputs, created, draft } = args;
  const travel = plan.travel.chosen as NonNullable<Plan['travel']['chosen']>;
  const place = plan.basics.destination;
  let createdAppointmentId: string | undefined;
  let createdParticipantId: string | undefined;

  try {
    // 1. 약속 (새 약속일 때만 만듦)
    let appointment: Pick<AppointmentRow, 'appointment_id' | 'title' | 'appointment_at'> | undefined = inputs.appointment;
    if (!appointment) {
      if (!created) throw new HttpError('VALIDATION_FAILED', 'appointment_id 또는 appointment가 필요해요');
      const row = must<AppointmentRow>(
        'appointments insert',
        await service
          .from('appointments')
          .insert({
            creator_id: userId,
            group_id: created.groupId ?? null,
            title: created.title,
            appointment_at: plan.basics.at.toISOString(),
            dest_name: place.name,
            dest_lat: place.lat ?? null,
            dest_lng: place.lng ?? null,
            dest_radius_m: draft.destination?.radiusM ?? null, // 목적지 감지 반경 (D68). 새 약속일 때만 — 기존 약속은 안 고침
            importance: plan.basics.importance,
            recurrence_rule: created.recurrenceRule ?? null, // D44. 이 호출은 첫 회차만 만듦 — 다음 회차는 alarm-roll이 14일치를 미리 만듦 (D4 A, roll.ts)
          })
          .select(APPOINTMENT_COLUMNS)
          .single(),
      );
      createdAppointmentId = row.appointment_id;
      appointment = row;
    }

    // 2. 내 참여 조건 (이동 · 준비 · 여유는 약속 시점 값을 그대로 보관, 4.4)
    const participantFields = {
      origin_name: plan.basics.origin.name,
      origin_lat: plan.basics.origin.lat ?? null,
      origin_lng: plan.basics.origin.lng ?? null,
      transport_type: plan.basics.transport,
      est_travel_minutes: plan.travelMinutes,
      travel_source: travel.source,
      prepare_minutes: plan.prepare.minutes,
      buffer_minutes: plan.basics.bufferMinutes,
    };
    let participantId: string;
    if (inputs.participant) {
      participantId = inputs.participant.participant_id;
      must('appointment_participants update', await service.from('appointment_participants').update(participantFields).eq('participant_id', participantId).eq('user_id', userId));
    } else {
      const row = must<{ participant_id: string }>(
        'appointment_participants insert',
        await service.from('appointment_participants').insert({ appointment_id: appointment.appointment_id, user_id: userId, ...participantFields }).select('participant_id').single(),
      );
      participantId = row.participant_id;
      createdParticipantId = participantId;
    }

    // 3. 알람 — 고치기 → 만들기 → 지우기 순 (중간에 실패해도 있던 알람이 먼저 사라지지 않게)
    const diff = diffAlarms(plan, inputs.existingAlarms, { now, enabled: draft.enabled, replaceExisting: args.replaceExisting });
    const touched: AlarmRow[] = [];
    for (const u of diff.update) {
      touched.push(
        must<AlarmRow>('alarms update', await service.from('alarms').update(u.patch).eq('alarm_id', u.alarm_id).eq('user_id', userId).select(ALARM_COLUMNS).single()),
      );
    }
    if (diff.insert.length) {
      const rows = diff.insert.map((w: AlarmWrite) => ({ ...w, user_id: userId, participant_id: participantId }));
      touched.push(...must<AlarmRow[]>('alarms insert', await service.from('alarms').insert(rows).select(ALARM_COLUMNS)));
    }
    if (diff.remove.length) {
      must('alarms delete', await service.from('alarms').delete().in('alarm_id', diff.remove).eq('user_id', userId));
    }
    const untouched = inputs.existingAlarms.filter((a) => !diff.remove.includes(a.alarm_id) && !diff.update.some((u) => u.alarm_id === a.alarm_id));
    const after = [...touched, ...untouched];

    // 4. 고친 값 기록 (user_edit_logs) — 요청에 담긴 것만. 같은 요청을 다시 보내면 같은 줄이 또 들어감 (멱등 키는 아직 없음)
    await saveEditLogs(ctx, appointment.appointment_id, after, args.edits);

    // 5. 응답
    return {
      appointment_id: appointment.appointment_id,
      participant_id: participantId,
      alarms: after.map(summarize),
      ring_packages: buildRingPackages({
        alarms: after,
        title: appointment.title,
        subtitle: subtitleFor(new Date(appointment.appointment_at), place.name, args.timeZone),
        departAt: plan.departure,
        // 준비 · 출발 알림 문구와 기상 음성 문장 (앱 reconcile이 같은 값으로 같은 문구를 만듦 — 이동은 저장한 est_travel_minutes)
        appointment: { appointmentAt: new Date(appointment.appointment_at), travelMinutes: plan.travelMinutes, timeZone: args.timeZone },
      }),
      canceled_alarm_ids: canceledAlarmIds({ before: inputs.existingAlarms, after }),
      warnings: plan.warnings,
    };
  } catch (e) {
    // 이번 호출이 새로 만든 것만 되돌림 (기존 약속 · 참여 조건 · 알람은 그대로 — 같은 요청을 다시 보내면 이어서 맞춰짐)
    try {
      if (createdAppointmentId) await service.from('appointments').delete().eq('appointment_id', createdAppointmentId);
      else if (createdParticipantId) await service.from('appointment_participants').delete().eq('participant_id', createdParticipantId);
    } catch (rollbackError) {
      console.error('[alarm-commit] 되돌리기 실패', rollbackError);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 일정 없는 알람 (D46 · Q10 B)
// ---------------------------------------------------------------------------

export async function commitStandalone(ctx: CommitCtx, args: { alarm: StandaloneInput; edits: readonly EditInput[]; timeZone: string }) {
  const { userDb, service, userId, now } = ctx;
  const { alarm } = args;

  let existing: AlarmRow | null = null;
  if (alarm.alarmId) {
    // 일정 없는 알람(약속 · 루틴과 연결 안 됨)만 고칠 수 있음
    existing = must<AlarmRow | null>(
      'alarm lookup',
      await userDb.from('alarms').select(ALARM_COLUMNS).eq('alarm_id', alarm.alarmId).eq('user_id', userId).is('participant_id', null).is('routine_id', null).maybeSingle(),
    );
    if (!existing) throw new HttpError('NOT_FOUND', '고칠 알람을 찾을 수 없어요');
  }

  const scheduledAt = alarm.scheduledAt ?? (existing ? new Date(existing.scheduled_at) : undefined);
  if (!scheduledAt) throw new HttpError('VALIDATION_FAILED', 'scheduled_at이 필요해요');
  const isEnabled = alarm.isEnabled ?? existing?.is_enabled ?? true;
  // 요청이 새로 보낸 시각이 이미 지났으면 울릴 수 없음. 끄는 요청은 시각과 상관없이 받음
  // 시각 없이 강도 · 켜기만 고치는 요청은 저장돼 있던 시각을 검사하지 않음 — 반복 알람은 첫 회차가 지나면 옛 시각이 남는데(D4 전),
  // 그 알람을 켜도 알람 코어가 지난 시각은 건너뛰므로(skipped_past) 안전함. 회차 넘기기는 D4 뒤
  if (alarm.scheduledAt != null && isEnabled && alarm.scheduledAt.getTime() < now.getTime()) {
    throw new HttpError('UNPROCESSABLE', '이미 지난 시각이라 알람을 만들 수 없어요', { reason: 'PAST_TIME' });
  }

  // 일정이 없으니 중요도 점수도 늦잠 보정도 없음 → 중(NORMAL)이 자동 값 (작성자 판단 — 화면 입력이 정해지면 바뀔 수 있음). 고른 칸만 직접 값
  //   잠귀(profiles.wake_sensitivity)는 일정이 아니라 사람 기준이라 여기도 적용 — 깊음이면 자동 강 (헤드 확정 10/30, 학습 기초 b)
  const wakeSensitivity = wakeSensitivityOf((await loadProfile(userDb, userId)).wake_sensitivity);
  const intensity = resolveIntensity('NORMAL', 0, resolveOverrides(alarm.levels, existing ? [existing] : [], autoLevel('NORMAL', 0, wakeSensitivity)), wakeSensitivity);
  const write: AlarmWrite = {
    alarm_type: 'WAKE',
    scheduled_at: scheduledAt.toISOString(),
    intensity: intensity.fields.intensity,
    voice_tone: intensity.fields.voiceTone,
    sound_key: intensity.fields.soundKey,
    vibration: intensity.fields.vibration,
    is_enabled: isEnabled,
    time_source: 'MANUAL', // 시각 전부를 사용자가 정함
    intensity_source: intensity.manual ? 'MANUAL' : 'AUTO',
    last_calculated_at: now.toISOString(),
  };
  const recurrence = alarm.recurrenceRule !== undefined ? alarm.recurrenceRule : (existing?.recurrence_rule ?? null); // D46 · Q10: 반복은 RRULE, 다음 회차는 alarm-roll이 새 행으로 (일정 없는 알람은 series_id · occurrence_on, D4 A)

  const saved = existing
    ? must<AlarmRow>('alarms update', await service.from('alarms').update({ ...write, recurrence_rule: recurrence }).eq('alarm_id', existing.alarm_id).eq('user_id', userId).select(ALARM_COLUMNS).single())
    : must<AlarmRow>(
        'alarms insert',
        await service.from('alarms').insert({ ...write, recurrence_rule: recurrence, user_id: userId, participant_id: null, routine_id: null }).select(ALARM_COLUMNS).single(),
      );

  await saveEditLogs(ctx, null, [saved], args.edits);

  return {
    alarm_id: saved.alarm_id,
    alarms: [summarize(saved)],
    ring_packages: buildRingPackages({ alarms: [saved], title: '알람', subtitle: subtitleFor(scheduledAt, null, args.timeZone) }),
    canceled_alarm_ids: canceledAlarmIds({ before: existing ? [existing] : [], after: [saved] }),
    warnings: [],
  };
}
