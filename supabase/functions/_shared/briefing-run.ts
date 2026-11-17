// alarm-briefing 함수의 판단 부분 — DB에서 읽은 값(BriefingSource)으로 단계별 문장(Android TTS용)을 만들고,
//   3 · 4단계가 실제로 올 수 있는 알람만 그 단계의 Gemini 음성을 미리 만듦 (한도 안에서, 폰에 없는 열쇠만). DB 읽기는 alarm-briefing/index.ts, 시험은 briefing-run.test.ts
//   단계마다 따로 성공 · 실패. 한도가 모자라면 실제 지각 위험인 4단계를 먼저 (3단계는 다음 맞추기에서 또는 폰의 예비 WAV)
//   Gemini가 실패 · 한도 초과여도 던지지 않음 — 폰은 그 단계의 예비 WAV(기상) 또는 Android TTS로 같은 문장 전체를 읽음
import {
  briefingClips,
  cleanPrefs,
  needsGemini,
  pickAppointments,
  resolveVoice,
  startLevelOf,
  GEMINI_STAGE,
  urgencyRule,
  wakeMemo,
  TTS_MODEL,
  type GeminiLevel,
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
import { finalizeScripts, wakeScriptInput, type ScriptResult, type ScriptStatus, type WakeScriptInput } from './wake-script.ts';

export type BriefingSource = {
  kind: BriefKind;
  scheduledAtMs: number; // 알람 시각
  timeZone: string;
  prefs: unknown; // profiles.alarm_voice_prefs (jsonb 그대로)
  importance: Importance; // 일정의 내부 자동 중요도
  voiceTone?: 'CALM' | 'NEUTRAL' | 'DIRECT' | null; // 이 알람의 말소리(자동 또는 직접 고름) → 시작 단계 약 1 · 중 2 · 강 3
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
  audio: { level: GeminiLevel; hash: string; mime: string; data: string }[]; // 새로 만든 Gemini 음성 (3 · 4단계)
  gemini: GeminiStatus; // 단계 결과 중 가장 나쁜 것 (앱 요약용)
  levels?: Partial<Record<GeminiLevel, GeminiStatus>>; // 단계별 결과 (필요한 단계만)
  script?: ScriptStatus; // 개인화 기상 대본 결과 (기상만). CACHED · MADE가 아니면 템플릿 문장
};

export type GeminiStatus = 'NOT_NEEDED' | 'CACHED' | 'MADE' | 'LIMITED' | 'FAILED' | 'NOT_CONFIGURED';
const WORST_FIRST: GeminiStatus[] = ['FAILED', 'LIMITED', 'NOT_CONFIGURED', 'MADE', 'CACHED', 'NOT_NEEDED'];
// 한도가 모자랄 때 먼저 만들 단계 — 실제 지각 위험(4)이 먼저
const GEMINI_ORDER: GeminiLevel[] = [4, 3];

// script = 개인화 기상 대본 만들기(wake-script.ts wakeScriptsFor). 없으면 템플릿 문장만
// hold = 아직 Gemini(대본 · 음성)를 부르지 않음 — 알람 날 새벽 4시 · 전날 대화 정리 전 (briefing-handler.ts). 템플릿 문장만 주고 폰은 예비 WAV · Android TTS
export type GeminiDeps = { tts: Tts | null; quota: TtsQuota; model?: string; script?: ((input: WakeScriptInput) => Promise<ScriptResult>) | null; hold?: boolean };

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
  const toneMap = { CALM: 'GENTLE', NEUTRAL: 'NORMAL', DIRECT: 'FIRM' } as const;
  if (src.voiceTone) profile.tone = toneMap[src.voiceTone]; // 알람의 말소리(자동 또는 직접 고름)가 프로필 말투보다 우선 (profile.tone은 표시용, 단계는 startLevel이 정함)
  if (!profile.enabled) return { enabled: false, rule: null, clips: [], audio: [], gemini: 'NOT_NEEDED' };
  const rule = urgencyRule(
    { kind: src.kind, appointmentAtMs: src.done ? null : src.appointmentAtMs, prepMinutes: src.prepMinutes, travelMinutes: src.travelMinutes },
    startLevelOf(src.voiceTone),
  );
  const model = gemini.model ?? TTS_MODEL;
  const wake = src.kind === 'WAKE';
  const days = briefingDays(src.scheduledAtMs, src.timeZone);
  const input = {
    kind: src.kind,
    memo: wake && profile.personal ? wakeMemo(src.sessions, days.review) : null,
    appointments: wake ? pickAppointments(src.appointments.filter((a) => a.atMs >= src.scheduledAtMs)) : src.appointments.slice(0, 1),
    todos: src.todos,
    departAtMs: wake ? src.departAtMs : null,
    timeZone: src.timeZone,
  };
  // Gemini(대본 · 음성)는 기상 알람이고, 그날 알람 뒤 일정이 있고, 알람 날 4시 · 정리 뒤(hold 아님)일 때만. 출발 · 일정 없는 날 · 4시 전은 템플릿 문장만
  //   (일정 없는 기상 = 사용자가 직접 만든 알람 — 지우거나 끄지 않고 Android TTS · 예비 WAV로 그대로 울림)
  const ai = wake && !gemini.hold && input.appointments.length > 0;
  // 기상만: Gemini 한 번으로 1~4단계 대본 (캐시 · 한도 · 실패는 wakeScriptsFor가 처리, 실패면 템플릿)
  const scriptInput = ai && gemini.script ? wakeScriptInput(input, days.day, src.done ? null : src.appointmentAtMs) : null;
  const script = scriptInput && gemini.script ? await gemini.script(scriptInput) : null;
  const texts = scriptInput && script?.scripts ? finalizeScripts(script.scripts, scriptInput) : null;
  const clips = briefingClips(rule, profile, input, model, texts);
  const out: BriefingOut = { enabled: true, rule, clips, audio: [], gemini: 'NOT_NEEDED', ...(script ? { script: script.status } : {}) };

  if (!ai) return out;
  // 4단계 먼저, 차례로 (동시에 부르면 분당 한도를 두 단계가 다퉈 4단계가 밀릴 수 있음)
  const levels: Partial<Record<GeminiLevel, GeminiStatus>> = {};
  for (const level of GEMINI_ORDER) {
    const clip = clips.find((c) => c.level === level);
    if (!clip || !needsGemini(rule, src.kind, src.scheduledAtMs, level)) continue;
    const r = await geminiClip(level, clip, have, gemini, model);
    levels[level] = r.status;
    if (r.audio) out.audio.push(r.audio);
  }
  const statuses = Object.values(levels);
  if (!statuses.length) return out;
  return { ...out, gemini: WORST_FIRST.find((s) => statuses.includes(s)) ?? 'NOT_NEEDED', levels };
}

async function geminiClip(
  level: GeminiLevel,
  clip: BriefingClip,
  have: ReadonlySet<string>,
  gemini: GeminiDeps,
  model: string,
): Promise<{ status: GeminiStatus; audio?: BriefingOut['audio'][number] }> {
  if (have.has(clip.hash)) return { status: 'CACHED' };
  if (!gemini.tts) return { status: 'NOT_CONFIGURED' };

  let pending = inflight.get(clip.hash);
  if (!pending) {
    const tts = gemini.tts;
    const { voice, style } = GEMINI_STAGE[level];
    // 예약부터 맵에 올려 둠 — 같은 인스턴스에 동시에 온 같은 요청은 예약도 한 번 (다른 인스턴스끼리는 DB 잠금이 막음)
    pending = (async () => {
      // DB가 한도 확인과 예약을 한 번에 — 예약에 성공했을 때만 Gemini를 부름 (예약 실패 · DB 오류 · 한도 초과 → 예비 WAV · Android TTS)
      const callId = await gemini.quota.reserve(model).catch(() => null);
      if (!callId) throw new QuotaLimited();
      const started = Date.now();
      try {
        const a = await tts({ model, text: clip.text, voice, style });
        await gemini.quota.finish(callId, { ok: true, errorCode: null, latencyMs: Date.now() - started }).catch(() => undefined);
        return a;
      } catch (e) {
        await gemini.quota.finish(callId, { ok: false, errorCode: e instanceof LlmClientError ? e.kind : 'unknown', latencyMs: Date.now() - started }).catch(() => undefined);
        throw e;
      }
    })();
    inflight.set(clip.hash, pending);
    void pending.catch(() => undefined).finally(() => inflight.delete(clip.hash));
  }
  try {
    const a = await pending;
    return { status: 'MADE', audio: { level, hash: clip.hash, mime: a.mime, data: a.data } };
  } catch (e) {
    if (e instanceof QuotaLimited) return { status: 'LIMITED' };
    console.warn(`[alarm-briefing] ${level}단계 음성을 못 만듦 — 폰은 예비 WAV · Android TTS로: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
    return { status: e instanceof LlmClientError && e.kind === 'rate_limit' ? 'LIMITED' : 'FAILED' };
  }
}
