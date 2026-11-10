// alarm-briefing 함수의 판단 부분 — DB에서 읽은 값(BriefingSource)으로 단계별 문장(Android TTS용)을 만들고,
//   긴급(4단계)이 실제로 올 수 있는 알람만 Gemini 음성을 미리 만듦 (한도 안에서, 폰에 없는 열쇠만). DB 읽기는 alarm-briefing/index.ts, 시험은 briefing-run.test.ts
//   Gemini가 실패 · 한도 초과여도 던지지 않음 — 폰은 Android TTS로 같은 문장 전체를 읽음
import {
  briefingClips,
  cleanPrefs,
  needsGemini,
  pickAppointments,
  resolveVoice,
  urgencyRule,
  wakeMemo,
  GEMINI_URGENT_STYLE,
  TTS_MODEL,
  type BriefAppointment,
  type BriefingClip,
  type BriefKind,
  type BriefTodo,
  type Importance,
  type StructuredLike,
  type UrgencyRule,
} from './briefing.ts';
import { LlmClientError } from './ai/llm.ts';
import type { Tts, TtsAudio } from './ai/tts.ts';
import type { TtsQuota } from './ai/tts-quota.ts';
import { localDateKey } from './tz.ts';

export type BriefingSource = {
  kind: BriefKind;
  scheduledAtMs: number; // 알람 시각
  timeZone: string;
  prefs: unknown; // profiles.alarm_voice_prefs (jsonb 그대로)
  importance: Importance; // 이 알람이 붙은 일정의 중요도. 일정 없는 알람은 LOW
  appointmentAtMs: number | null; // 이 알람이 붙은 일정 시각 (일정 없는 알람은 null → 지각 위험 UNKNOWN)
  prepMinutes: number | null; // 참여 조건의 준비 분
  travelMinutes: number | null; // 참여 조건의 이동 분 (est_travel_minutes)
  departAtMs: number | null; // 기상 알람의 같은 약속 출발 알람 시각
  done: boolean; // 이미 출발 · 도착 기록이 있음 → 지각 위험 DONE (긴급 없음)
  appointments: BriefAppointment[]; // 기상 = 그날 내 일정, 출발 = 그 일정 하나
  todos: BriefTodo[]; // 기상 = 그날 할 일 · 준비물, 출발 = 그 일정의 준비물
  sessions: StructuredLike[]; // 기준일(알람 날 − 1) 대화들의 extracted_data (기상만)
};

export type BriefingOut = {
  enabled: boolean; // 사용자가 끄면 false — 폰은 저장된 브리핑을 지움
  rule: UrgencyRule | null;
  clips: BriefingClip[]; // 폰이 Android TTS로 읽을 단계별 문장 · 높낮이 · 속도 · 목소리 번호
  audio: { level: 4; hash: string; mime: string; data: string }[]; // 새로 만든 Gemini 음성 (긴급만)
  gemini: 'NOT_NEEDED' | 'CACHED' | 'MADE' | 'LIMITED' | 'FAILED' | 'NOT_CONFIGURED';
};

export type GeminiDeps = { tts: Tts | null; quota: TtsQuota; model?: string };

// 알람 날짜 · 대화 기준일 — 알람 날 아침의 전날 밤 대화는 기준일 = 알람 날 − 1 (turn-core dayOf: review = morning − 1)
export function briefingDays(scheduledAtMs: number, timeZone: string): { day: string; review: string } {
  const day = localDateKey(new Date(scheduledAtMs), timeZone);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { day, review: d.toISOString().slice(0, 10) };
}

// 같은 서버 인스턴스에서 같은 음성(열쇠)을 동시에 두 번 만들지 않음 — 뒤 요청은 앞 요청 결과를 기다림
const inflight = new Map<string, Promise<TtsAudio>>();
class QuotaLimited extends Error {}

export async function runBriefing(src: BriefingSource, have: ReadonlySet<string>, gemini: GeminiDeps): Promise<BriefingOut> {
  const profile = resolveVoice(src.importance, cleanPrefs(src.prefs));
  if (!profile.enabled) return { enabled: false, rule: null, clips: [], audio: [], gemini: 'NOT_NEEDED' };
  const rule = urgencyRule({ kind: src.kind, appointmentAtMs: src.done ? null : src.appointmentAtMs, prepMinutes: src.prepMinutes, travelMinutes: src.travelMinutes }, profile);
  const model = gemini.model ?? TTS_MODEL;
  const wake = src.kind === 'WAKE';
  const clips = briefingClips(rule, profile, {
    kind: src.kind,
    memo: wake && profile.personal ? wakeMemo(src.sessions, briefingDays(src.scheduledAtMs, src.timeZone).review) : null,
    appointments: wake ? pickAppointments(src.appointments.filter((a) => a.atMs >= src.scheduledAtMs)) : src.appointments.slice(0, 1),
    todos: src.todos,
    departAtMs: wake ? src.departAtMs : null,
    timeZone: src.timeZone,
  }, model);
  const out: BriefingOut = { enabled: true, rule, clips, audio: [], gemini: 'NOT_NEEDED' };

  const urgent = clips.find((c) => c.level === 4);
  if (!urgent || !needsGemini(rule, src.kind, src.scheduledAtMs)) return out;
  if (have.has(urgent.hash)) return { ...out, gemini: 'CACHED' };
  if (!gemini.tts) return { ...out, gemini: 'NOT_CONFIGURED' };

  let pending = inflight.get(urgent.hash);
  if (!pending) {
    const tts = gemini.tts;
    // 예약부터 맵에 올려 둠 — 같은 인스턴스에 동시에 온 같은 요청은 예약도 한 번 (다른 인스턴스끼리는 DB 잠금이 막음)
    pending = (async () => {
      // DB가 한도 확인과 예약을 한 번에 — 예약에 성공했을 때만 Gemini를 부름 (예약 실패 · DB 오류 · 한도 초과 → Android TTS)
      const callId = await gemini.quota.reserve(model).catch(() => null);
      if (!callId) throw new QuotaLimited();
      const started = Date.now();
      try {
        const a = await tts({ model, text: urgent.text, voice: profile.voice, style: GEMINI_URGENT_STYLE });
        await gemini.quota.finish(callId, { ok: true, errorCode: null, latencyMs: Date.now() - started }).catch(() => undefined);
        return a;
      } catch (e) {
        await gemini.quota.finish(callId, { ok: false, errorCode: e instanceof LlmClientError ? e.kind : 'unknown', latencyMs: Date.now() - started }).catch(() => undefined);
        throw e;
      }
    })();
    inflight.set(urgent.hash, pending);
    void pending.catch(() => undefined).finally(() => inflight.delete(urgent.hash));
  }
  try {
    const a = await pending;
    return { ...out, audio: [{ level: 4, hash: urgent.hash, mime: a.mime, data: a.data }], gemini: 'MADE' };
  } catch (e) {
    if (!(e instanceof QuotaLimited)) console.warn(`[alarm-briefing] 긴급 음성을 못 만듦 — 폰은 Android TTS로: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
    if (e instanceof QuotaLimited) return { ...out, gemini: 'LIMITED' };
    return { ...out, gemini: e instanceof LlmClientError && e.kind === 'rate_limit' ? 'LIMITED' : 'FAILED' };
  }
}
