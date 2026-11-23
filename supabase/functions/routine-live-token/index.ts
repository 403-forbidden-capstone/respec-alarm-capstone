// routine-live-token — 아침 루틴 음성 진행(Gemini Live) 1회용 토큰 (자기 전 대화 voice-live-token과 같은 방식, 지침 · 도구만 루틴용)
//   요청: { routine_id } — 내 루틴(켜진 것)만. 응답: { token, model }
//   지침에 오늘 루틴 단계 · 다음 알람(준비 · 출발) · 첫 일정을 붙이고, 도구 step_done · step_skipped · routine_finished를 잠금 — 본문은 _shared/ai/routine-live.ts
//   1회용 · 1분 안에 연결 · 최대 10분. 로그인한 사용자만 (config.toml verify_jwt + requireUser). 읽기는 부른 사람의 권한(RLS)
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · NOT_FOUND(내 켜진 루틴이 아니거나 단계 없음) · NOT_CONFIGURED(키 없음) · VOICE_UNAVAILABLE
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createLiveToken } from '../_shared/ai/live-token.ts';
import { parseRoutineSteps, routineBriefText, routineLiveTokenBody, type RoutineBrief } from '../_shared/ai/routine-live.ts';
import { requireUser } from '../_shared/auth.ts';
import { must } from '../_shared/db.ts';
import { requireEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { Reader, readJson } from '../_shared/read.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const key = requireEnv('GEMINI_API_KEY');
    const r = Reader.root(await readJson(req));
    const routineId = r.uuid('routine_id', { required: true }) as string;
    r.finish();

    const row = must<{ title: string; goal: string | null; steps: unknown } | null>(
      'routines',
      await user.db.from('routines').select('title, goal, steps').eq('user_id', user.userId).eq('routine_id', routineId).eq('is_active', true).maybeSingle(),
    );
    const steps = row ? parseRoutineSteps(row.steps) : [];
    if (!row || !steps.length) throw new HttpError('NOT_FOUND', '루틴을 찾을 수 없어요');

    // 루틴 뒤 다음 알람(준비 · 출발)과 그 일정 — 지금부터 12시간 안
    const now = Date.now();
    const next = must<{ alarm_type: 'PREPARE' | 'DEPARTURE'; scheduled_at: string; appointment_participants: { appointments: { title: string; appointment_at: string } | null } | null }[]>(
      'alarms',
      await user.db
        .from('alarms')
        .select('alarm_type, scheduled_at, appointment_participants(appointments(title, appointment_at))')
        .eq('user_id', user.userId)
        .eq('is_enabled', true)
        .in('alarm_type', ['PREPARE', 'DEPARTURE'])
        .gt('scheduled_at', new Date(now).toISOString())
        .lt('scheduled_at', new Date(now + 12 * 3_600_000).toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(1),
    )[0];
    const plan = next?.appointment_participants?.appointments ?? null;
    const brief: RoutineBrief = {
      title: row.title,
      goal: row.goal,
      steps,
      nextAlarm: next ? { type: next.alarm_type, at: next.scheduled_at } : null,
      firstPlan: plan ? { title: plan.title, at: plan.appointment_at } : null,
    };
    return jsonResponse(await createLiveToken(key, { now, body: routineLiveTokenBody(now, routineBriefText(brief)) }));
  }),
);
