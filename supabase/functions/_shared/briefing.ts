// 알람 AI 음성 브리핑 — 순수 함수만 (서버 alarm-briefing · 앱 lib/alarmSync/briefing이 같이 씀, 시험: briefing.test.ts)
//   · 일정 중요도(LOW 약 · NORMAL 중간 · HIGH 중요)는 목소리 · 말투 기본값만 정함. 사용자 수동 설정(profiles.alarm_voice_prefs)이 이김
//   · 음성 단계: 기본 1, 스누즈 1번 2, 2번 이상 3, 남은 여유 5분 이하면 최소 3, 0분 이하면 4
//   · 엔진: 1 · 2단계는 폰의 Android TTS, 3단계(엄마 Gacrux) · 4단계(긴급 Kore)는 미리 만든 Gemini 음성
//     — 개인화 캐시가 없으면 앱에 든 단계별 예비 WAV(기상만), 그것도 못 틀면 Android TTS로 같은 단계 문장 전체 (한 울림에 한 엔진)
//   · 기상(WAKE) = 전날 대화 다짐 + 오늘 일정, 출발(DEPARTURE) = 그 일정 시각 + 준비물 + 출발 촉구. 기록에 없는 말은 안 만듦
// 알람 볼륨 · 진동 · 배경음은 여기서 안 정함 — 기존 알람 축(calc/intensity.ts D69, H03 수동 선택)이 그대로 정함
import { formatKoSpokenTime } from './tz.ts';

export type Importance = 'LOW' | 'NORMAL' | 'HIGH';
export type UrgencyLevel = 1 | 2 | 3 | 4;
export type ToneKey = 'GENTLE' | 'NORMAL' | 'FIRM';
export type BriefKind = 'WAKE' | 'DEPARTURE';

// Gemini TTS — 3 · 4단계 (aistudio.google.com/docs/speech-generation 11/12 확인: 한국어 · 24kHz WAV · speech_metadata.style, 목소리 Gacrux · Kore 있음)
//   한국어 대사는 text, 감정 · 속도 지시(영어)는 speech_metadata.style로 따로 보냄. 사용자 설정과 별개인 단계별 고정 목소리
export const TTS_MODEL = 'gemini-3.8-flash-tts';
export type GeminiLevel = 3 | 4;
export const GEMINI_STAGE: Record<GeminiLevel, { voice: string; style: string }> = {
  // 3단계 — 폭발한 한국 엄마 (지시문은 기획 확정본 그대로, 고치지 않음)
  3: {
    voice: 'Gacrux',
    style: [
      'Perform in natural Korean as a furious, extremely worried Korean mother who has just discovered that her child is still sleeping and is about to miss an important appointment.',
      'Emotion: explosive anger, panic, desperation, frustration, and extreme urgency.',
      'Start with an explosive, piercing shout at the top of your voice. The very first word must be exceptionally loud, sharp, and startling, as if a Korean mother has suddenly burst into the bedroom to wake her oversleeping child.',
      'Use a mature, commanding female voice with powerful vocal projection. Sound like a real Korean mother who has completely lost her patience and is desperately trying to get her child out of bed.',
      'Speak at an extremely fast pace, significantly faster than normal conversation. Fire off short, forceful commands in rapid succession, with almost no pauses between sentences.',
      'Strongly emphasize the commands to wake up immediately. Maintain intense urgency and increase the emotional intensity throughout the speech. Sound genuinely furious and desperate, as if there is absolutely no time left to waste.',
      'Keep the delivery spontaneous, realistic, and overwhelmingly urgent. Do not sound like a professional voice actor, an announcer, or a cartoon character.',
      'Do not stretch out words, take long breaths, or slow down for dramatic effect. Maintain clear Korean pronunciation even while shouting at high speed.',
      'Do not read punctuation aloud.',
      "Deliver the command \"지금 당장 일어나\" with the strongest, most explosive shout in the entire speech, as if this is the mother's final warning. Immediately continue with the next command without slowing down.",
    ].join('\n\n'),
  },
  // 4단계 — 기존 긴급 목소리 · 지시 (앱에 든 gemini_urgent_sample.wav와 같은 설정)
  4: {
    voice: 'Kore',
    style: 'panicked, desperate shouting at the top of the voice; very fast, every phrase strongly stressed, breathless urgent intonation (forceful but never insulting)',
  },
};
export const isGeminiLevel = (level: number): level is GeminiLevel => level === 3 || level === 4;

// 앱에 든 단계별 기본 예비 음성(res/raw) — 파일명은 예전 이름 그대로 두고 단계에 다시 배정 (3단계 ← gemini_stage4_fallback.wav, 4단계 ← gemini_urgent_sample.wav)
//   개인 정보 없는 일반 문장. 파일은 scripts/make-fallback-voices.ts로 한 번 만든 것 (재생 · 빌드 때 API 호출 없음)
export const GEMINI_FALLBACK_FILE: Record<GeminiLevel, string> = {
  3: 'gemini_stage4_fallback.wav',
  4: 'gemini_urgent_sample.wav',
};
// 그 파일의 대사 (4단계 파일은 느낌표를 반복한 원문으로 만들었고, 화면에는 speakable로 정리해 보임)
export const GEMINI_FALLBACK_TEXT: Record<GeminiLevel, string> = {
  3: '야! 너 안 일어나?! 지금 몇 시인 줄 알아? 지금 당장 일어나! 빨리 일어나라고!',
  4: '야!!!!!!!!!! 지금 안 일어나면 진짜 늦어!!!! 지금 당장 일어나!!!!!!!',
};

// 사용자가 고르는 목소리는 Android 오프라인 TTS 번호(휴대폰마다 실제 음색은 달라질 수 있음). Gemini 4단계는 선택할 수 없음
export const VOICES: readonly { id: string; label: string }[] = [
  { id: 'Sulafat', label: '따뜻한' },
  { id: 'Zephyr', label: '밝은' },
  { id: 'Kore', label: '단호한' },
];

export const TONES: Record<ToneKey, { label: string }> = {
  GENTLE: { label: '다정하게' },
  NORMAL: { label: '또렷하게' },
  FIRM: { label: '단호하게' },
};

// 중요도별 개발팀 기본값 — 목소리 · 말투
export const IMPORTANCE_VOICE: Record<Importance, { voice: string; tone: ToneKey }> = {
  LOW: { voice: 'Sulafat', tone: 'GENTLE' },
  NORMAL: { voice: 'Zephyr', tone: 'NORMAL' },
  HIGH: { voice: 'Kore', tone: 'FIRM' },
};

/** profiles.alarm_voice_prefs — 칸이 없으면 자동(개발팀 기본값). 사용자가 고른 칸만 들어 있음 → 지우면 기본값으로 돌아감 */
export type VoicePrefs = {
  enabled?: boolean; // AI 음성 브리핑 (기본 켬)
  voice?: string; // 목소리 (VOICES id)
  tone?: ToneKey; // 말투
  coachMax?: UrgencyLevel; // 예전 저장값 호환용. 긴급 단계는 사용자 설정으로 끌 수 없음
  escalate?: boolean; // 예전 저장값 호환용. 단계 전환은 현재 자동 적용
  personal?: boolean; // 전날 대화 내용을 알람에 넣기 (기본 켬)
};

export const DEFAULT_COACH_MAX: UrgencyLevel = 4;

/** DB jsonb를 믿지 않고 아는 칸 · 맞는 값만 남김 */
export function cleanPrefs(raw: unknown): VoicePrefs {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: VoicePrefs = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.voice === 'string' && VOICES.some((v) => v.id === r.voice)) out.voice = r.voice;
  if (typeof r.tone === 'string' && r.tone in TONES) out.tone = r.tone as ToneKey;
  if (r.coachMax === 1 || r.coachMax === 2 || r.coachMax === 3 || r.coachMax === 4) out.coachMax = r.coachMax;
  if (typeof r.escalate === 'boolean') out.escalate = r.escalate;
  if (typeof r.personal === 'boolean') out.personal = r.personal;
  return out;
}

export type VoiceProfile = {
  enabled: boolean;
  voice: string;
  tone: ToneKey;
  coachMax: UrgencyLevel;
  escalate: boolean;
  personal: boolean;
  manual: { voice: boolean; tone: boolean };
};

/** 사용자 수동 설정 > 중요도별 기본값 */
export function resolveVoice(importance: Importance, prefs: VoicePrefs = {}): VoiceProfile {
  const base = IMPORTANCE_VOICE[importance] ?? IMPORTANCE_VOICE.LOW;
  return {
    enabled: prefs.enabled ?? true,
    voice: prefs.voice ?? base.voice,
    tone: prefs.tone ?? base.tone,
    coachMax: DEFAULT_COACH_MAX,
    escalate: true,
    personal: prefs.personal ?? true,
    manual: { voice: prefs.voice != null, tone: prefs.tone != null },
  };
}

// ---------------------------------------------------------------------------
// 남은 여유 = 약속 − 이동 − (현재 시각 + 준비). 정확히 5분/0분 경계를 구분하기 위해 시간 차이를 초 단위로 계산
//   기상: 남은 여유 = 약속 − 지금 − 준비 − 이동 / 출발: 약속 − 지금 − 이동
// ---------------------------------------------------------------------------

export const SLACK_SAFE_OVER = 30; // 이 분 초과면 여유
export const SLACK_CAUTION_OVER = 15; // 15 초과 ~ 30 이하 주의
export const SLACK_DANGER_OVER = 5; // 5분 이하는 Android TTS 3단계
export const SLACK_URGENT_OVER = 0; // 0분 이하는 Gemini 4단계

export type LateRisk = 'SAFE' | 'CAUTION' | 'DANGER' | 'IMMINENT' | 'URGENT' | 'UNKNOWN' | 'DONE';

export type SlackInput = { kind: BriefKind; appointmentAtMs: number | null; prepMinutes: number | null; travelMinutes: number | null };

const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;

/** 남은 여유(분). 약속 시각 · 이동(기상이면 준비도)을 모르면 null = UNKNOWN (임의로 단정하지 않음) */
export function slackMinutes(s: SlackInput, nowMs: number): number | null {
  if (s.appointmentAtMs == null || !Number.isFinite(s.appointmentAtMs) || !known(s.travelMinutes)) return null;
  if (s.kind === 'WAKE' && !known(s.prepMinutes)) return null;
  const used = s.travelMinutes + (s.kind === 'WAKE' ? (s.prepMinutes as number) : 0);
  return (s.appointmentAtMs - nowMs) / 60_000 - used;
}

/** done = 이미 출발했거나(출발 기록) 기상 알람인데 이미 기상 확인함 → 지각 위험을 따지지 않음 */
export function lateRisk(slack: number | null, done = false): LateRisk {
  if (done) return 'DONE';
  if (slack == null) return 'UNKNOWN';
  if (slack > SLACK_SAFE_OVER) return 'SAFE';
  if (slack > SLACK_CAUTION_OVER) return 'CAUTION';
  if (slack > SLACK_DANGER_OVER) return 'DANGER';
  if (slack > SLACK_URGENT_OVER) return 'IMMINENT';
  return 'URGENT';
}

/** 여유 5분이면 최소 3, 0분이면 4. 스누즈는 1→2→3. maxLevel은 예전 기기/테스트 호환용. */
export function speechLevel(snoozeCount: number, risk: LateRisk, maxLevel: UrgencyLevel): UrgencyLevel {
  const snoozeLevel = Math.min(Math.max(0, snoozeCount) + 1, 3);
  const level = risk === 'URGENT' ? 4 : risk === 'IMMINENT' ? Math.max(3, snoozeLevel) : snoozeLevel;
  return Math.max(1, Math.min(level, maxLevel)) as UrgencyLevel;
}

// ---------------------------------------------------------------------------
// 폰에서는 예약 시 계산해 저장한 두 시각(여유 5분/0분)과 현재 시간을 비교. 알람 울리는 도중에도 반복 확인함.
// ---------------------------------------------------------------------------

export type UrgencyRule = { dangerAtMs?: number | null; urgentAtMs: number | null; maxLevel: UrgencyLevel };

function thresholdAtMs(s: SlackInput, slack: number): number | null {
  if (s.appointmentAtMs == null || !Number.isFinite(s.appointmentAtMs) || !known(s.travelMinutes)) return null;
  if (s.kind === 'WAKE' && !known(s.prepMinutes)) return null;
  const used = s.travelMinutes + (s.kind === 'WAKE' ? (s.prepMinutes as number) : 0);
  return s.appointmentAtMs - (used + slack) * 60_000;
}

/** 여유가 정확히 5분이 되는 시각. 3단계 Android TTS로 변경 */
export function dangerAtMs(s: SlackInput): number | null { return thresholdAtMs(s, SLACK_DANGER_OVER); }
/** 여유가 정확히 0분이 되는 시각. 4단계 Gemini(또는 Android 대체)로 변경 */
export function urgentAtMs(s: SlackInput): number | null { return thresholdAtMs(s, SLACK_URGENT_OVER); }

export function urgencyRule(s: SlackInput, _profile: Pick<VoiceProfile, 'coachMax' | 'escalate'>): UrgencyRule {
  return { dangerAtMs: dangerAtMs(s), urgentAtMs: urgentAtMs(s), maxLevel: 4 };
}

export function levelAt(rule: UrgencyRule, snoozeCount: number, nowMs: number): UrgencyLevel {
  const urgent = rule.urgentAtMs != null && nowMs >= rule.urgentAtMs;
  const imminent = rule.dangerAtMs != null && nowMs >= rule.dangerAtMs;
  return speechLevel(snoozeCount, urgent ? 'URGENT' : imminent ? 'IMMINENT' : 'SAFE', rule.maxLevel);
}

/** 한 울림의 엔진 — 3 · 4단계이고 Gemini 음성(개인화 캐시 또는 예비 WAV)이 있을 때만 Gemini, 아니면 Android TTS로 전체 브리핑 */
export function engineFor(level: UrgencyLevel, hasGeminiClip: boolean): 'GEMINI' | 'ANDROID' {
  return isGeminiLevel(level) && hasGeminiClip ? 'GEMINI' : 'ANDROID';
}

// 기상 알람은 사용자가 끄지 않으면 계속 울리므로 예약 시 여유 0분 시각이 예상되면 캐시를 준비함. 출발 알림은 한 번 읽고 끝남
export const GEMINI_WINDOW_MIN: Record<BriefKind, number> = { WAKE: 24 * 60, DEPARTURE: 1 }; // 기상은 해제 전까지 무기한 울릴 수 있어 하루 전부터 캐시 준비 (한도 준수)

/**
 * 그 단계의 개인화 Gemini 음성이 필요한지 — 이 알람이 울리는 동안 실제로 그 단계가 될 수 있을 때만
 *   4단계: 여유 0분 시각이 울림 안에 올 때만 (스누즈 3번이어도 여유가 있으면 안 만듦)
 *   3단계: 기상은 스누즈 2번만으로도 오므로 늘, 출발(스누즈 없음)은 여유 5분 시각이 울림 안에 올 때만
 */
export function needsGemini(rule: UrgencyRule, kind: BriefKind, ringAtMs: number, level: GeminiLevel = 4): boolean {
  if (rule.maxLevel < level) return false;
  const until = ringAtMs + GEMINI_WINDOW_MIN[kind] * 60_000;
  if (level === 4) return rule.urgentAtMs != null && rule.urgentAtMs < until;
  if (kind === 'WAKE') return true;
  const at = rule.dangerAtMs ?? rule.urgentAtMs;
  return at != null && at < until;
}

/** 미리 만들 단계 — 1 ~ 상한 */
export function levelsToPrepare(rule: UrgencyRule): UrgencyLevel[] {
  return ([1, 2, 3, 4] as const).filter((l) => l <= rule.maxLevel);
}

// Android TTS 높낮이 · 속도 (setPitch · setSpeechRate 값 그대로, 1.0 = 기본) — 단계별 고정값. 말투에 더하지 않음 (기획 확정: 1단계 1.0/1.0, 2단계 1.7/1.5)
//   3 · 4단계는 Gemini가 기본이고 Android TTS는 대체로 읽을 때만 — 2단계와 같은 강한 값 (작성자 판단)
//   네이티브 BriefingRules.FALLBACK_VOICE와 같은 값 — 고치면 둘 다
const LEVEL_VOICE: Record<UrgencyLevel, { pitch: number; rate: number }> = {
  1: { pitch: 1.0, rate: 1.0 },
  2: { pitch: 1.7, rate: 1.5 },
  3: { pitch: 1.7, rate: 1.5 },
  4: { pitch: 1.7, rate: 1.5 },
};

export type AndroidVoice = { pitch: number; rate: number; voiceIndex: number };

/** 목소리는 사용자 설정(중요도 기본값 또는 직접 고름) 그대로, 높낮이 · 속도는 단계 고정값 */
export function androidVoice(profile: Pick<VoiceProfile, 'voice' | 'tone'>, level: UrgencyLevel): AndroidVoice {
  return { ...LEVEL_VOICE[level], voiceIndex: Math.max(0, VOICES.findIndex((v) => v.id === profile.voice)) };
}

// ---------------------------------------------------------------------------
// 전날 대화에서 꺼낸 기상 동기 — structured.v1에서 사용자가 직접 말했거나(stated) 확인한(confirmed) 것만. 짐작(inferred)은 안 씀
// ---------------------------------------------------------------------------

type Told = { source?: string };
export type StructuredLike = {
  schema_version?: string;
  session?: { reference_date?: string };
  goals_routine?: { goals?: ({ habit?: string; goal_text?: string } & Told)[] };
  habit_signals?: ({ habit?: string } & Told)[];
  sleep_wake?: ({ overslept?: boolean | null } & Told)[];
  schedule_outcomes?: ({ is_late?: boolean | null; causes?: string[] } & Told)[];
  other?: { safety_flag?: boolean };
};

export type WakeMemo = { wakeEarly: boolean; overslept: boolean; lateByOversleep: boolean; goals: string[] };

const WAKE_HABITS = new Set(['snooze_repeat', 'irregular_wake']);
const GOAL_MAX_CHARS = 30;
const told = (x: Told): boolean => x.source === 'stated' || x.source === 'confirmed';

/** 그 기준일(reviewDate = 알람 날 − 1, 대화 기준일 규칙 turn-core dayOf)의 대화들에서 꺼냄. 꺼낼 것이 없으면 null (기본 멘트) */
export function wakeMemo(list: readonly StructuredLike[], reviewDate: string): WakeMemo | null {
  const day = list.filter((s) => s.schema_version === 'structured.v1' && s.session?.reference_date === reviewDate && !s.other?.safety_flag);
  const goals = day.flatMap((s) => (s.goals_routine?.goals ?? []).filter(told));
  const wakeEarly = goals.some((g) => WAKE_HABITS.has(g.habit ?? ''));
  const overslept =
    day.some((s) => (s.sleep_wake ?? []).some((w) => told(w) && w.overslept === true)) ||
    day.some((s) => (s.habit_signals ?? []).some((h) => told(h) && WAKE_HABITS.has(h.habit ?? '')));
  const lateByOversleep = day.some((s) => (s.schedule_outcomes ?? []).some((o) => told(o) && o.is_late === true && (o.causes ?? []).includes('overslept')));
  const others = [
    ...new Set(
      goals
        .filter((g) => !WAKE_HABITS.has(g.habit ?? ''))
        .map((g) => (g.goal_text ?? '').trim())
        .filter((t) => t.length > 0 && t.length <= GOAL_MAX_CHARS),
    ),
  ].slice(0, 2);
  if (!wakeEarly && !overslept && !lateByOversleep && !others.length) return null;
  return { wakeEarly, overslept: overslept || lateByOversleep, lateByOversleep, goals: others };
}

// ---------------------------------------------------------------------------
// 일정 고르기 · 브리핑 문장
// ---------------------------------------------------------------------------

export type BriefAppointment = { title: string; atMs: number; importance: Importance };
export type BriefTodo = { title: string; type: 'TASK' | 'ITEM' };

export const MAX_APPOINTMENTS = 3;
const IMPORTANCE_RANK: Record<Importance, number> = { HIGH: 2, NORMAL: 1, LOW: 0 };

/** DB에 있는 일정만, 시간순. 많으면 가장 가까운 일정 + 중요한 일정 순으로 max개를 고른 뒤 다시 시간순 */
export function pickAppointments(list: readonly BriefAppointment[], max = MAX_APPOINTMENTS): BriefAppointment[] {
  const sorted = list.filter((a) => a.title.trim() && Number.isFinite(a.atMs)).sort((a, b) => a.atMs - b.atMs);
  if (sorted.length <= max) return sorted;
  const [first, ...rest] = sorted;
  const chosen = [first, ...[...rest].sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] || a.atMs - b.atMs).slice(0, max - 1)];
  return chosen.sort((a, b) => a.atMs - b.atMs);
}

export type BriefingInput = {
  kind: BriefKind;
  memo: WakeMemo | null; // 기상만. 사용자가 전날 대화를 끄면 null
  appointments: readonly BriefAppointment[]; // 기상 = 그날 일정(pickAppointments), 출발 = 그 일정 하나
  todos: readonly BriefTodo[]; // 기상 = 그날 할 일 · 준비물, 출발 = 그 일정의 준비물
  departAtMs: number | null; // 기상 알람의 같은 약속 출발 시각 (고정 시각이라 캐시해도 낡지 않음)
  timeZone: string;
};

const MAX_TODOS = 3;
const list = (xs: readonly string[]) => xs.join(', ');
const spoken = (ms: number, tz: string) => formatKoSpokenTime(new Date(ms), tz);
const apptLine = (a: BriefAppointment, tz: string) => `${spoken(a.atMs, tz)} ${a.title.trim()}`;
const titles = (todos: readonly BriefTodo[], type: BriefTodo['type']) => todos.filter((t) => t.type === type).map((t) => t.title.trim()).filter(Boolean).slice(0, MAX_TODOS);

function scheduleSentence(input: BriefingInput): string {
  const appts = input.appointments.map((a) => apptLine(a, input.timeZone));
  if (!appts.length) return '오늘은 등록된 일정이 없어.';
  if (appts.length === 1) return `오늘은 ${appts[0]} 일정이 있어.`;
  return `오늘은 ${list(appts)} 순서로 일정이 있어.`;
}

function importantSentence(input: BriefingInput): string | null {
  const important = input.appointments.find((a) => a.importance === 'HIGH');
  return important ? `특히 ${important.title.trim()} 일정은 중요하니까 꼭 챙기자.` : null;
}

function todoSentences(input: BriefingInput): string[] {
  const items = titles(input.todos, 'ITEM');
  const tasks = titles(input.todos, 'TASK');
  return [items.length ? `챙길 것: ${list(items)}.` : null, tasks.length ? `오늘 할 일: ${list(tasks)}.` : null].filter((s): s is string => s != null);
}

function departSentence(input: BriefingInput, strong: boolean): string | null {
  if (input.departAtMs == null) return null;
  const t = spoken(input.departAtMs, input.timeZone);
  return strong ? `${t}에는 나가야 해!` : `${t}에는 나가야 하니까`;
}

// 다짐 · 반성 문장 — 사용자가 말한 것만 (memo 칸이 true일 때만 그 문장)
function memoGentle(m: WakeMemo | null): string[] {
  if (!m) return [];
  return [
    m.wakeEarly ? '어제 오늘부터는 일찍 일어나겠다고 했잖아.' : null,
    m.lateByOversleep ? '늦잠 때문에 지각했던 거, 오늘은 다르게 해 보자.' : m.overslept && !m.wakeEarly ? '요즘 늦잠 때문에 힘들다고 했었지.' : null,
    ...m.goals.map((g) => `어제 세운 목표, "${g}" 잊지 말자.`),
  ].filter((s): s is string => s != null);
}

function memoFirm(m: WakeMemo | null): string[] {
  if (!m) return [];
  return [
    m.wakeEarly ? '어제 일찍 일어나겠다고 했잖아!' : null,
    m.lateByOversleep ? '또 늦잠 자서 지각할 거야?' : null,
    !m.wakeEarly && !m.lateByOversleep && m.goals.length ? `어제 세운 목표, "${m.goals[0]}" 기억하지?` : null,
  ].filter((s): s is string => s != null);
}

function memoShout(m: WakeMemo | null): string[] {
  if (!m) return [];
  return [
    m.wakeEarly ? '너 어제 일찍 일어나고 싶다며!' : null,
    m.lateByOversleep ? '늦잠 자서 지각했다고 반성했잖아! 또 지각할 거야?' : null,
    m.lateByOversleep || m.wakeEarly ? '어제 다짐했으면 오늘 실천해야지!' : null,
  ].filter((s): s is string => s != null);
}

function quickSchedule(input: BriefingInput): string | null {
  const appts = input.appointments.slice(0, 2).map((a) => apptLine(a, input.timeZone));
  return appts.length ? `오늘 ${list(appts)} 있잖아` : null;
}

// 2 · 3단계는 스누즈 없이도 시간만 지나 올라갈 수 있어 "미뤘다"고 단정하지 않음. 4단계는 여유 0분 이하에서만 "늦는다"고 말함
//   3단계 음성은 미리 한 번 만들어 두고 스누즈로 와도 같은 파일을 틀므로, 시간이 촉박하다고 단정하는 말("지금 일어나야 딱 맞게 도착해")은 안 넣음
//   감정 · 세기는 Gemini 영어 지시(GEMINI_STAGE)가 맡음 — 느낌표를 여러 개 이어 붙이지 않음
function wakeText(level: UrgencyLevel, input: BriefingInput): (string | null)[] {
  if (level === 1) {
    const depart = departSentence(input, false);
    return ['좋은 아침이야~', ...memoGentle(input.memo), scheduleSentence(input), importantSentence(input), ...todoSentences(input), depart ? `${depart} 슬슬 일어나서 준비해 볼까?` : '슬슬 일어나서 준비해 볼까?'];
  }
  if (level === 2) {
    const quick = quickSchedule(input);
    return ['야, 이제 진짜 일어나야 해. 더 미루면 준비하기 힘들어.', ...memoFirm(input.memo), quick ? `${quick}.` : null, importantSentence(input), '얼른 일어나.'];
  }
  if (level === 3) {
    const quick = quickSchedule(input);
    return ['야, 근데 이제 진짜 일어나야 돼. 계속 자면 안 되잖아.', ...memoFirm(input.memo), quick ? `${quick}.` : null, departSentence(input, true), '얼른 일어나서 준비해!'];
  }
  const quick = quickSchedule(input);
  return ['야! 너 안 일어나?! 지금 안 일어나면 진짜 늦어!', ...memoShout(input.memo), quick ? `${quick}!` : null, '지금 당장 일어나! 빨리 일어나라고!'];
}

function departureText(level: UrgencyLevel, input: BriefingInput): (string | null)[] {
  const a = input.appointments[0];
  const what = a ? apptLine(a, input.timeZone) : null;
  const items = titles(input.todos, 'ITEM');
  if (level === 1) return [what ? `${what} 갈 시간이야.` : '나갈 시간이야.', items.length ? `챙길 것: ${list(items)}.` : null, '이제 출발하자!'];
  if (level === 2) return [what ? `${what}, 늦지 않게 지금 나가야 해!` : '늦지 않게 지금 나가야 해!', items.length ? `챙길 것: ${list(items)}.` : null, '바로 출발해!'];
  if (level === 3) return ['야, 지금 바로 나가야 돼.', what ? `${what} 있잖아.` : null, items.length ? `챙길 것: ${list(items)}.` : null, '얼른 출발해!'];
  return ['야! 지금 당장 나가!', a ? `이러다 ${a.title.trim()} 늦는다고!` : '이러다 늦는다고!', items.length ? `${list(items)} 챙기고 바로 출발해!` : '바로 출발해!'];
}

/** 소리 내 읽기 전에 이어 붙은 느낌표 · 물음표만 줄임 ("회의!!!" → "회의!", "진짜???" → "진짜?", "?!?!" → "?!"). 글자 · 뜻은 안 바꿈 */
export function speakable(s: string): string {
  return s.replace(/([!?])\1+/g, '$1').replace(/[!?]{3,}/g, (m) => m.slice(0, 2));
}

/** 단계별 알람 음성 문장 — 알람이 울리는 동안 이 문장 하나를 읽음. 사용자가 적은 일정 · 준비물 · 목표의 반복 부호도 같이 정리 */
export function briefingText(level: UrgencyLevel, input: BriefingInput): string {
  const parts = input.kind === 'DEPARTURE' ? departureText(level, input) : wakeText(level, input);
  return speakable(parts.filter((s): s is string => !!s).join(' '));
}

// ---------------------------------------------------------------------------
// 캐시 열쇠 — 문장 · 목소리 · 지시 · 모델이 같으면 같은 음성이라 다시 만들지 않음 (서버 · 앱 · 시험에서 같은 값: FNV-1a 64비트)
// ---------------------------------------------------------------------------

export function clipHash(parts: { text: string; voice: string; style: string; model: string }): string {
  const s = `${parts.model}\u0000${parts.voice}\u0000${parts.style}\u0000${parts.text}`;
  let h = 0xcbf29ce484222325n;
  for (const ch of s) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export type BriefingClip = { level: UrgencyLevel; text: string; hash: string } & AndroidVoice;

/** 단계별 문장 + Android TTS 값 + 캐시 열쇠 (3 · 4단계는 그 단계의 Gemini 모델 · 목소리 · 지시 · 대사가 다 들어감 → 하나라도 바뀌면 새 음성) */
export function briefingClips(rule: UrgencyRule, profile: Pick<VoiceProfile, 'voice' | 'tone'>, input: BriefingInput, model = TTS_MODEL): BriefingClip[] {
  return levelsToPrepare(rule).map((level) => {
    const text = briefingText(level, input);
    const g = isGeminiLevel(level) ? GEMINI_STAGE[level] : { voice: profile.voice, style: '' };
    return { level, text, hash: clipHash({ text, voice: g.voice, style: g.style, model }), ...androidVoice(profile, level) };
  });
}
