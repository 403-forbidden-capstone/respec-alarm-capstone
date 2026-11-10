// alarm-briefing — 기상 알람 하나의 AI 음성 브리핑(긴급도 단계별 문장 + Gemini TTS 음성)을 미리 만들어 폰에 줌
//   앱이 알람을 폰에 맞춘 뒤(lib/alarmSync/briefing.ts) 다가오는 기상 알람마다 부름 → 폰이 음성 파일로 저장 → 알람이 울리면 네트워크 없이 바로 재생
//   요청: { alarm_id, have?: string[] }  have = 폰에 이미 있는 음성의 열쇠(hash). 같은 열쇠는 다시 만들지 않음 (같은 내용으로 AI를 다시 안 부름)
//   응답: BriefingOut (_shared/briefing-run.ts) — enabled · rule(울릴 때 단계 판단 값) · clips(단계별 열쇠 · 문장) · audio(새로 만든 것만) · failed
//   로그인한 본인 알람만 (requireUser 사용자 DB = RLS + user_id로 한 번 더 좁힘). 음성은 서버에 저장하지 않고 응답으로만 줌 → 다른 사용자가 가져갈 곳이 없음
//   키가 없으면(GEMINI_API_KEY) 문장 · 규칙만 주고 음성은 failed — 폰은 기본 알람음으로 울림
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createTts } from '../_shared/ai/tts.ts';
import { requireUser } from '../_shared/auth.ts';
import type { BriefAppointment, BriefTodo, Importance, StructuredLike } from '../_shared/briefing.ts';
import { briefingDays, runBriefing } from '../_shared/briefing-run.ts';
import { must } from '../_shared/db.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { loadLateCount } from '../_shared/plan.ts';
import { localDayRange, safeTimeZone } from '../_shared/tz.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{16}$/;

type AlarmRow = { alarm_id: string; alarm_type: string; scheduled_at: string; is_enabled: boolean; participant_id: string | null };
type ParticipantRow = { prepare_minutes: number | null; appointments: { importance: Importance } | null };
type DayRow = { appointment_id: string; appointments: { title: string; appointment_at: string; importance: Importance; exception_kind: string | null } };

Deno.serve(
  serve(async (req) => {
    const { userId, db } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { alarm_id?: unknown; have?: unknown };
    if (typeof body.alarm_id !== 'string' || !UUID.test(body.alarm_id)) throw new HttpError('VALIDATION_FAILED', 'alarm_id가 필요해요');
    const have = new Set(Array.isArray(body.have) ? body.have.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(0, 8) : []);

    const alarm = must<AlarmRow | null>(
      'alarm',
      await db.from('alarms').select('alarm_id, alarm_type, scheduled_at, is_enabled, participant_id').eq('alarm_id', body.alarm_id).eq('user_id', userId).maybeSingle(),
    );
    if (!alarm || alarm.alarm_type !== 'WAKE' || !alarm.is_enabled) throw new HttpError('NOT_FOUND', '기상 알람이 없어요');

    const profile = must<{ timezone: string | null; alarm_voice_prefs: unknown } | null>(
      'profile',
      await db.from('profiles').select('timezone, alarm_voice_prefs').eq('user_id', userId).maybeSingle(),
    );
    const timeZone = safeTimeZone(profile?.timezone);
    const scheduledAtMs = Date.parse(alarm.scheduled_at);
    const { day, review } = briefingDays(scheduledAtMs, timeZone);
    const { start, end } = localDayRange(new Date(scheduledAtMs), timeZone);

    let importance: Importance = 'NORMAL';
    let prepMinutes: number | null = null;
    let departAtMs: number | null = null;
    if (alarm.participant_id) {
      const p = must<ParticipantRow | null>(
        'participant',
        await db.from('appointment_participants').select('prepare_minutes, appointments(importance)').eq('participant_id', alarm.participant_id).eq('user_id', userId).maybeSingle(),
      );
      importance = p?.appointments?.importance ?? 'NORMAL';
      prepMinutes = p?.prepare_minutes ?? null;
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
    const appointments: BriefAppointment[] = dayRows.map((r) => ({ title: r.appointments.title, atMs: Date.parse(r.appointments.appointment_at), importance: r.appointments.importance }));
    const ids = dayRows.map((r) => r.appointment_id);

    // 그날 마감인 할 일 + 그날 일정에 붙은 준비물 · 할 일 (안 끝낸 것만)
    const todoFilter = ids.length ? `due_date.eq.${day},appointment_id.in.(${ids.join(',')})` : `due_date.eq.${day}`;
    const todos = must<{ title: string; todo_type: 'TASK' | 'ITEM' }[]>(
      'todos',
      await db.from('todos').select('title, todo_type').eq('user_id', userId).eq('is_done', false).or(todoFilter).order('created_at').limit(20),
    ).map((t): BriefTodo => ({ title: t.title, type: t.todo_type }));

    const sessions = must<{ extracted_data: StructuredLike | null }[]>(
      'sessions',
      await db.from('conversation_sessions').select('extracted_data').eq('user_id', userId).eq('extracted_data->session->>reference_date', review),
    ).flatMap((s) => (s.extracted_data ? [s.extracted_data] : []));

    const key = getEnv('GEMINI_API_KEY');
    const out = await runBriefing(
      {
        scheduledAtMs,
        timeZone,
        prefs: profile?.alarm_voice_prefs,
        importance,
        prepMinutes,
        departAtMs,
        lateCount4w: await loadLateCount(db, userId, new Date()),
        appointments,
        todos,
        sessions,
      },
      have,
      key ? createTts(key) : null,
    );
    return jsonResponse(out);
  }),
);
