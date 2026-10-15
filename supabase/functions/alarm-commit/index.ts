// alarm-commit — 약속 · 참여 조건 · 알람을 한 번에 저장 (상세설계서 5장 5.4.2, 화면 H05 · H03 · S01)
//   약속 알람:   새 약속(appointment) 또는 기존 약속(appointment_id)에 내 참여 조건과 알람을 만들거나 고침.
//               기존 약속의 제목 · 시각 · 장소 · 중요도는 이 함수가 고치지 않음 (D41). 공동 약속은 멤버가 각자 appointment_id로 불러 자기 몫을 계산 (#46)
//   일정 없는 알람(type STANDALONE): 시각 + 반복(RRULE)만으로 기상 알람 하나 (D46 · Q10 B). 약속 · 루틴과 연결하지 않음
//   응답: 저장된 알람 + ring_packages(폰에 걸 예약 꾸러미, 알람 코어 RingPackage) + canceled_alarm_ids(폰에서 지울 예약, 반드시 같이 줌)
//   오류: VALIDATION_FAILED · NOT_FOUND · FORBIDDEN · UNPROCESSABLE(출발 시각까지 지남 · 알람 순서 어긋남) · ROUTE_UNAVAILABLE(이동시간을 정할 수 없음)
// 쓰기는 service_role로 하되, 읽기(약속 · 내 기록)는 부른 사람의 RLS로 해서 남의 일정에는 닿지 못함.
// supabase-js에는 트랜잭션이 없어 순서(약속 → 참여 조건 → 알람 → 고친 값 기록)대로 쓰고, 이번 호출이 새로 만든 약속 · 참여 조건은
// 중간에 실패하면 지워서(CASCADE) 되돌림. 같은 요청을 다시 보내도 같은 상태가 됨. 근본 해결은 DB 함수(RPC)로 묶는 것 — README 질문
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser, type AuthedUser } from '../_shared/auth.ts';
import { buildEditLogRows, diffAlarms, type AlarmWrite, type EditInput } from '../_shared/commit-core.ts';
import { resolveIntensity } from '../_shared/calc/index.ts';
import { must } from '../_shared/db.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { buildPlan, loadProfile } from '../_shared/plan.ts';
import { resolveOverrides, type AlarmRow, type AppointmentRow } from '../_shared/plan-core.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readCommitRequest, type CommitRequest } from '../_shared/requests.ts';
import { buildRingPackages, canceledAlarmIds, subtitleFor } from '../_shared/ring-package.ts';
import { createServiceClient, type Db } from '../_shared/supabase.ts';
import { safeTimeZone } from '../_shared/tz.ts';

type Ctx = { user: AuthedUser; service: Db; now: Date };

const ALARM_COLUMNS =
  'alarm_id, participant_id, user_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, is_enabled, snooze_limit, time_source, intensity_source, recurrence_rule';
const APPOINTMENT_COLUMNS = 'appointment_id, creator_id, group_id, title, appointment_at, dest_name, dest_lat, dest_lng, importance, recurrence_rule';

// 응답에 싣는 알람 요약
const summarize = (a: AlarmRow) => ({
  alarm_id: a.alarm_id,
  alarm_type: a.alarm_type,
  scheduled_at: a.scheduled_at,
  is_enabled: a.is_enabled,
  intensity: a.intensity,
  voice_tone: a.voice_tone,
  sound_key: a.sound_key,
  time_source: a.time_source,
  intensity_source: a.intensity_source,
  recurrence_rule: a.recurrence_rule,
});

async function saveEditLogs(ctx: Ctx, appointmentId: string | null, alarms: readonly AlarmRow[], edits: readonly EditInput[]) {
  if (!edits.length) return;
  const rows = buildEditLogRows(ctx.user.userId, appointmentId, alarms, edits);
  must('user_edit_logs', await ctx.service.from('user_edit_logs').insert(rows));
}

// ---------------------------------------------------------------------------
// 약속 알람
// ---------------------------------------------------------------------------

async function commitAppointment(ctx: Ctx, request: Extract<CommitRequest, { type: 'APPOINTMENT' }>) {
  const { user, service, now } = ctx;
  const { draft, appointment: created } = request;

  // 새 공동 약속이면 내가 그 그룹에 참여 중이어야 함 (appointments RLS의 insert 조건과 같음)
  if (created?.groupId) {
    const member = must<{ group_id: string } | null>(
      'group_members',
      await user.db.from('group_members').select('group_id').eq('group_id', created.groupId).eq('user_id', user.userId).eq('invite_status', 'JOINED').maybeSingle(),
    );
    if (!member) throw new HttpError('FORBIDDEN', '이 그룹에 참여 중이 아니라서 공동 약속을 만들 수 없어요');
  }

  // 계산 + 검증 (미리 보기와 같은 계산). 기존 약속이 안 보이면 NOT_FOUND
  const { plan, inputs, timeZone } = await buildPlan({ userId: user.userId, db: user.db, now, kakaoKey: getEnv('KAKAO_REST_API_KEY') }, draft);

  // 이동시간은 길찾기 값(API)이나 사용자가 정한 값(MANUAL)만 저장. 서버가 대신 구한 같은 경로 중앙값(CACHED)은 D5가 열려 있어 쓰지 않고,
  // 직선거리 근사값(ESTIMATE)은 사용자가 확인해야 하므로 확인한 값을 MANUAL로 다시 보내게 함 (7장 7.1.2 단계 4)
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

  const userId = user.userId;
  const place = plan.basics.destination;
  let createdAppointmentId: string | undefined;
  let createdParticipantId: string | undefined;
  try {
    // 1. 약속 (새 약속일 때만 만듦 — 기존 약속은 안 고침)
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
            importance: plan.basics.importance,
            recurrence_rule: created.recurrenceRule ?? null, // D44. 알람은 첫 회차만 (D4)
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
    const diff = diffAlarms(plan, inputs.existingAlarms, { now, enabled: draft.enabled, replaceExisting: request.replaceExisting });
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
    await saveEditLogs(ctx, appointment.appointment_id, after, request.edits);

    // 5. 응답
    const ringPackages = buildRingPackages({
      alarms: after,
      title: appointment.title,
      subtitle: subtitleFor(new Date(appointment.appointment_at), place.name, timeZone),
      departAt: plan.departure,
    });
    return {
      appointment_id: appointment.appointment_id,
      participant_id: participantId,
      alarms: after.map(summarize),
      ring_packages: ringPackages,
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

async function commitStandalone(ctx: Ctx, request: Extract<CommitRequest, { type: 'STANDALONE' }>) {
  const { user, service, now } = ctx;
  const { alarm } = request;
  const userId = user.userId;
  const timeZone = safeTimeZone((await loadProfile(user.db, userId)).timezone);

  let existing: AlarmRow | null = null;
  if (alarm.alarmId) {
    // 일정 없는 알람(약속 · 루틴과 연결 안 됨)만 고칠 수 있음
    existing = must<AlarmRow | null>(
      'alarm lookup',
      await user.db.from('alarms').select(ALARM_COLUMNS).eq('alarm_id', alarm.alarmId).eq('user_id', userId).is('participant_id', null).is('routine_id', null).maybeSingle(),
    );
    if (!existing) throw new HttpError('NOT_FOUND', '고칠 알람을 찾을 수 없어요');
  }

  const scheduledAt = alarm.scheduledAt ?? (existing ? new Date(existing.scheduled_at) : undefined);
  if (!scheduledAt) throw new HttpError('VALIDATION_FAILED', 'scheduled_at이 필요해요');
  const isEnabled = alarm.isEnabled ?? existing?.is_enabled ?? true;
  // 켜 둘 알람의 시각이 이미 지났으면 울릴 수 없음. 끄는 요청은 시각과 상관없이 받음
  if (isEnabled && scheduledAt.getTime() < now.getTime()) {
    throw new HttpError('UNPROCESSABLE', '이미 지난 시각이라 알람을 만들 수 없어요', { reason: 'PAST_TIME' });
  }

  // 일정이 없으니 중요도 점수도 늦잠 보정도 없음 → 중(NORMAL)이 자동 값 (작성자 판단 — 화면 입력이 정해지면 바뀔 수 있음). 고른 칸만 직접 값
  const intensity = resolveIntensity('NORMAL', 0, resolveOverrides(alarm.levels, existing ? [existing] : [], 1));
  const write: AlarmWrite = {
    alarm_type: 'WAKE',
    scheduled_at: scheduledAt.toISOString(),
    intensity: intensity.fields.intensity,
    voice_tone: intensity.fields.voiceTone,
    sound_key: intensity.fields.soundKey,
    is_enabled: isEnabled,
    time_source: 'MANUAL', // 시각 전부를 사용자가 정함
    intensity_source: intensity.manual ? 'MANUAL' : 'AUTO',
    last_calculated_at: now.toISOString(),
  };
  const recurrence = alarm.recurrenceRule !== undefined ? alarm.recurrenceRule : (existing?.recurrence_rule ?? null); // D46 · Q10: 반복은 RRULE, 다음 회차 만들기는 D4 뒤

  const saved = existing
    ? must<AlarmRow>('alarms update', await service.from('alarms').update({ ...write, recurrence_rule: recurrence }).eq('alarm_id', existing.alarm_id).eq('user_id', userId).select(ALARM_COLUMNS).single())
    : must<AlarmRow>(
        'alarms insert',
        await service.from('alarms').insert({ ...write, recurrence_rule: recurrence, user_id: userId, participant_id: null, routine_id: null }).select(ALARM_COLUMNS).single(),
      );

  await saveEditLogs(ctx, null, [saved], request.edits);

  return {
    alarm_id: saved.alarm_id,
    alarms: [summarize(saved)],
    ring_packages: buildRingPackages({ alarms: [saved], title: '알람', subtitle: subtitleFor(scheduledAt, null, timeZone) }),
    canceled_alarm_ids: canceledAlarmIds({ before: existing ? [existing] : [], after: [saved] }),
    warnings: [],
  };
}

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const request = readCommitRequest(root);
    root.finish();

    const ctx: Ctx = { user, service: createServiceClient(), now: new Date() };
    const body = request.type === 'STANDALONE' ? await commitStandalone(ctx, request) : await commitAppointment(ctx, request);
    return jsonResponse(body);
  }),
);
