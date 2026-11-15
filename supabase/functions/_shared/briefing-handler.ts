// 알람 하나의 음성 브리핑 만들기 — alarm-briefing(앱 로그인 토큰)과 alarm-briefing-device(폰 백그라운드 갱신, 기기 키)가 같이 씀 (#515)
//   예전 alarm-briefing/index.ts 몸통을 그대로 옮김 — 판단 · 캐시 · 한도 · 대본 · 음성 규칙은 바뀌지 않음
//   db = 읽기에 쓰는 클라이언트. 앱 길은 사용자 DB(RLS), 기기 길은 서비스 키 — 그래서 모든 읽기에 user_id 조건을 직접 검 (기기 키로 남의 알람을 못 읽게)
//   kinds = 이 길로 받을 알람 종류 (기기 길은 기상만)
//   응답에 refresh_at(ms) — 기상 알람만, 그 아침의 전날 대화가 아직 새벽 정리(구조화) 전이면 다시 받을 시각 (_shared/briefing-refresh.ts). 아니면 null
import { geminiClient, geminiModel } from './ai/gemini.ts';
import { QuotaGate, quotaFromEnv } from './ai/quota.ts';
import { recordCalls } from './ai/session.ts';
import { createTts } from './ai/tts.ts';
import { dbTtsQuota } from './ai/tts-quota.ts';
import type { BriefAppointment, BriefTodo, Importance, StructuredLike } from './briefing.ts';
import { loadWakeData } from './briefing-load.ts';
import { briefingRefreshAt } from './briefing-refresh.ts';
import { type BriefingOut, briefingDays, runBriefing } from './briefing-run.ts';
import { must } from './db.ts';
import { getEnv } from './env.ts';
import { HttpError } from './errors.ts';
import type { Db } from './supabase.ts';
import { voiceToneOf } from './ring-package.ts';
import { safeTimeZone } from './tz.ts';
import { wakeScriptsFor } from './wake-script.ts';

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

export type AlarmKind = 'WAKE' | 'DEPARTURE';
export type BriefAlarmOut = BriefingOut & { refresh_at: number | null };

/** body = { alarm_id, have? } (have = 폰에 이미 있는 Gemini 음성 열쇠) */
export async function briefAlarm(a: { userId: string; db: Db; service: Db; kinds: readonly AlarmKind[] }, body: { alarm_id?: unknown; have?: unknown }): Promise<BriefAlarmOut> {
  const { userId, db, service, kinds } = a;
  if (typeof body.alarm_id !== 'string' || !UUID.test(body.alarm_id)) throw new HttpError('VALIDATION_FAILED', 'alarm_id가 필요해요');
  const have = new Set(Array.isArray(body.have) ? body.have.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(0, 8) : []);

  const alarm = must<AlarmRow | null>(
    'alarm',
    await db.from('alarms').select('alarm_type, scheduled_at, is_enabled, participant_id, voice_tone, intensity, intensity_source').eq('alarm_id', body.alarm_id).eq('user_id', userId).maybeSingle(),
  );
  const kind = alarm?.alarm_type === 'WAKE' || alarm?.alarm_type === 'DEPARTURE' ? alarm.alarm_type : null;
  if (!alarm || !kind || !alarm.is_enabled || !kinds.includes(kind)) throw new HttpError('NOT_FOUND', '기상 · 출발 알람이 없어요');

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
    // 그 일정의 준비물만 (안 챙긴 것, 개수 제한 없음)
    if (p) {
      todos = must<{ title: string }[]>(
        'items',
        await db.from('todos').select('title').eq('user_id', userId).eq('appointment_id', p.appointment_id).eq('todo_type', 'ITEM').eq('is_done', false).order('created_at'),
      ).map((t): BriefTodo => ({ title: t.title, type: 'ITEM' }));
    }
  } else {
    // 그날 일정 · 할 일 · 준비물 · 전날 대화 · 출발 시각 (_shared/briefing-load.ts — 개수 제한 없음, 지운 회차 · 지난 일정의 준비물 제외)
    ({ appointments, todos, sessions, departAtMs } = await loadWakeData(db, userId, { scheduledAtMs, timeZone, participantId: alarm.participant_id }));
  }

  // 브리핑을 만들기 전에 봄 — 만드는 사이에 정리가 끝나도 이번 대본은 정리 전 재료라 한 번 더 받아야 함
  //   이 확인이 실패해도 브리핑은 그대로 줌 (null = 다시 받을 때 없음, 다음 날 4:10 갱신 · 앱 열기에서 다시)
  const refresh_at =
    kind === 'WAKE'
      ? await briefingRefreshAt(service, userId, briefingDays(scheduledAtMs, timeZone).review, Date.now()).catch((e) => {
          console.warn('[alarm-briefing] 정리 확인 실패', e instanceof Error ? e.message : e);
          return null;
        })
      : null;

  const key = getEnv('GEMINI_API_KEY');
  const alarmId = body.alarm_id;
  const out = await runBriefing(
    {
      kind,
      scheduledAtMs,
      timeZone,
      prefs: profile?.alarm_voice_prefs,
      importance: own?.importance ?? 'LOW',
      // 말소리 칸 = 자동(중요도 · 지각 · 잠귀) 또는 직접 고른 값 → 시작 단계. 폰 예약 꾸러미와 같은 함수
      voiceTone: voiceToneOf(alarm),
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
    {
      tts: key ? createTts(key) : null,
      quota: dbTtsQuota(service, userId),
      script: (input) =>
        wakeScriptsFor(
          {
            service,
            userId,
            alarmId,
            client: geminiClient(),
            model: geminiModel(),
            gate: new QuotaGate(quotaFromEnv(getEnv)),
            record: (call) => recordCalls({ userId, userDb: db, service }, null, [{ call, io: null }], new Date().toISOString()),
          },
          input,
        ),
    },
  );
  return { ...out, refresh_at };
}
