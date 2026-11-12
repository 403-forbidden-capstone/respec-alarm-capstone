// alarm-briefing — 기상 · 출발 알람 하나의 음성 브리핑을 미리 만들어 폰에 줌 (앱 lib/alarmSync/briefing.ts가 폰 예약을 맞춘 뒤 부름)
//   단계별 문장 · Android TTS 값은 늘 주고, Gemini 음성은 3 · 4단계가 실제로 올 수 있는 알람만 · 한도 안에서(4단계 먼저) · 폰에 없을 때만 만듦
//   알람이 울리는 순간에는 이 함수를 부르지 않음 — 폰은 저장해 둔 것만 씀
//   요청: { alarm_id, have?: string[] }  have = 폰에 이미 있는 Gemini 음성 열쇠
//   응답: BriefingOut (_shared/briefing-run.ts)
//   로그인한 본인 알람만 (사용자 DB = RLS + user_id). 한도 셈 · 호출 기록만 서비스 키(프로젝트 전체를 세야 함). 음성은 서버에 저장하지 않음
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createTts } from '../_shared/ai/tts.ts';
import { dbTtsQuota } from '../_shared/ai/tts-quota.ts';
import { requireUser } from '../_shared/auth.ts';
import type { BriefAppointment, BriefTodo, Importance, StructuredLike } from '../_shared/briefing.ts';
import { briefingDays, runBriefing } from '../_shared/briefing-run.ts';
import { LEVEL_FIELDS, levelOfIntensity } from '../_shared/calc/intensity.ts';
import { must } from '../_shared/db.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { localDayRange, safeTimeZone } from '../_shared/tz.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{16}$/;

type AlarmRow = { alarm_type: string; scheduled_at: string; is_enabled: boolean; participant_id: string | null; voice_tone: 'CALM' | 'NEUTRAL' | 'DIRECT' | null; intensity: 'SOFT' | 'NORMAL' | 'STRONG'; intensity_source: 'AUTO' | 'MANUAL' };
type ParticipantRow = {
  appointment_id: string;
  prepare_minutes: number | null;
  est_travel_minutes: number | null;
  departed_at: string | null;
  arrived_at: string | null;
  appointments: { title: string; appointment_at: string; importance: Importance } | null;
};
type DayRow = { appointment_id: string; appointments: { title: string; appointment_at: string; importance: Importance; exception_kind: string | null } };

Deno.serve(
  serve(async (req) => {
    const { userId, db } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { alarm_id?: unknown; have?: unknown };
    if (typeof body.alarm_id !== 'string' || !UUID.test(body.alarm_id)) throw new HttpError('VALIDATION_FAILED', 'alarm_id가 필요해요');
    const have = new Set(Array.isArray(body.have) ? body.have.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(0, 8) : []);

    const alarm = must<AlarmRow | null>(
      'alarm',
      await db.from('alarms').select('alarm_type, scheduled_at, is_enabled, participant_id, voice_tone, intensity, intensity_source').eq('alarm_id', body.alarm_id).eq('user_id', userId).maybeSingle(),
    );
    const kind = alarm?.alarm_type === 'WAKE' || alarm?.alarm_type === 'DEPARTURE' ? alarm.alarm_type : null;
    if (!alarm || !kind || !alarm.is_enabled) throw new HttpError('NOT_FOUND', '기상 · 출발 알람이 없어요');

    const profile = must<{ timezone: string | null; alarm_voice_prefs: unknown } | null>(
      'profile',
      await db.from('profiles').select('timezone, alarm_voice_prefs').eq('user_id', userId).maybeSingle(),
    );
    const timeZone = safeTimeZone(profile?.timezone);
    const scheduledAtMs = Date.parse(alarm.scheduled_at);

    const p = alarm.participant_id
      ? must<ParticipantRow | null>(
          'participant',
          await db
            .from('appointment_participants')
            .select('appointment_id, prepare_minutes, est_travel_minutes, departed_at, arrived_at, appointments(title, appointment_at, importance)')
            .eq('participant_id', alarm.participant_id)
            .eq('user_id', userId)
            .maybeSingle(),
        )
      : null;
    const own = p?.appointments ? { title: p.appointments.title, atMs: Date.parse(p.appointments.appointment_at), importance: p.appointments.importance } : null;

    let appointments: BriefAppointment[] = own ? [own] : [];
    let todos: BriefTodo[] = [];
    let sessions: StructuredLike[] = [];
    let departAtMs: number | null = null;

    if (kind === 'DEPARTURE') {
      // 그 일정의 준비물만 (안 챙긴 것)
      if (p) {
        todos = must<{ title: string }[]>(
          'items',
          await db.from('todos').select('title').eq('user_id', userId).eq('appointment_id', p.appointment_id).eq('todo_type', 'ITEM').eq('is_done', false).order('created_at').limit(10),
        ).map((t): BriefTodo => ({ title: t.title, type: 'ITEM' }));
      }
    } else {
      const { day, review } = briefingDays(scheduledAtMs, timeZone);
      const { start, end } = localDayRange(new Date(scheduledAtMs), timeZone);
      if (alarm.participant_id) {
        const dep = must<{ scheduled_at: string }[]>(
          'departure',
          await db.from('alarms').select('scheduled_at').eq('user_id', userId).eq('participant_id', alarm.participant_id).eq('alarm_type', 'DEPARTURE').eq('is_enabled', true).limit(1),
        );
        departAtMs = dep[0] ? Date.parse(dep[0].scheduled_at) : null;
      }
      const dayRows = must<DayRow[]>(
        'day appointments',
        await db
          .from('appointment_participants')
          .select('appointment_id, appointments!inner(title, appointment_at, importance, exception_kind)')
          .eq('user_id', userId)
          .gte('appointments.appointment_at', start.toISOString())
          .lt('appointments.appointment_at', end.toISOString()),
      ).filter((r) => r.appointments.exception_kind !== 'CANCELED');
      appointments = dayRows.map((r) => ({ title: r.appointments.title, atMs: Date.parse(r.appointments.appointment_at), importance: r.appointments.importance }));
      const ids = dayRows.map((r) => r.appointment_id);
      // 그날 마감인 할 일 + 그날 일정에 붙은 준비물 · 할 일 (안 끝낸 것만)
      const todoFilter = ids.length ? `due_date.eq.${day},appointment_id.in.(${ids.join(',')})` : `due_date.eq.${day}`;
      todos = must<{ title: string; todo_type: 'TASK' | 'ITEM' }[]>(
        'todos',
        await db.from('todos').select('title, todo_type').eq('user_id', userId).eq('is_done', false).or(todoFilter).order('created_at').limit(20),
      ).map((t): BriefTodo => ({ title: t.title, type: t.todo_type }));
      sessions = must<{ extracted_data: StructuredLike | null }[]>(
        'sessions',
        await db.from('conversation_sessions').select('extracted_data').eq('user_id', userId).eq('extracted_data->session->>reference_date', review),
      ).flatMap((s) => (s.extracted_data ? [s.extracted_data] : []));
    }

    const key = getEnv('GEMINI_API_KEY');
    const out = await runBriefing(
      {
        kind,
        scheduledAtMs,
        timeZone,
        prefs: profile?.alarm_voice_prefs,
        importance: own?.importance ?? 'LOW',
        voiceTone: alarm.intensity_source === 'MANUAL' && alarm.voice_tone !== LEVEL_FIELDS[levelOfIntensity(alarm.intensity) ?? 1].voiceTone ? alarm.voice_tone : null,
        appointmentAtMs: own?.atMs ?? null,
        prepMinutes: p?.prepare_minutes ?? null,
        travelMinutes: p?.est_travel_minutes ?? null,
        departAtMs,
        done: p?.departed_at != null || p?.arrived_at != null, // 이미 출발 · 도착했으면 지각 위험을 안 따짐
        appointments,
        todos,
        sessions,
      },
      have,
      { tts: key ? createTts(key) : null, quota: dbTtsQuota(createServiceClient(), userId) },
    );
    return jsonResponse(out);
  }),
);
