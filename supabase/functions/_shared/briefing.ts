// 알람 AI 음성 브리핑 — 순수 함수만 (서버 alarm-briefing · 앱 lib/alarmSync/briefing이 같이 씀, 시험: briefing.test.ts)
//   · 일정 중요도(LOW 약 · NORMAL 중간 · HIGH 중요)는 목소리 · 말투 기본값만 정함. 사용자 수동 설정(profiles.alarm_voice_prefs)이 이김
//   · 알람 긴급도 1~4단계는 중요도와 별개: 처음 1 · 미루기 1번 2 · 2번 이상 3 · 실제 지각 위험(여유 5분 이하) 4
//   · 엔진: 1~3단계는 폰의 Android TTS, 4단계(긴급)만 미리 만든 Gemini 음성 — 없으면 Android TTS로 같은 문장 전체 (한 울림에 한 엔진)
//   · 기상(WAKE) = 전날 대화 다짐 + 오늘 일정, 출발(DEPARTURE) = 그 일정 시각 + 준비물 + 출발 촉구. 기록에 없는 말은 안 만듦
// 알람 볼륨 · 진동 · 배경음은 여기서 안 정함 — 기존 알람 축(calc/intensity.ts D69, H03 수동 선택)이 그대로 정함
import { departSlack } from './calc/depart.ts';
import { formatKoSpokenTime } from './tz.ts';

export type Importance = 'LOW' | 'NORMAL' | 'HIGH';
export type UrgencyLevel = 1 | 2 | 3 | 4;
export type ToneKey = 'GENTLE' | 'NORMAL' | 'FIRM';
export type BriefKind = 'WAKE' | 'DEPARTURE';

// Gemini TTS — 긴급(4단계)에만 (aistudio.google.com/docs/speech-generation 11/10 확인: 한국어 · 24kHz WAV · speech_metadata.style)
export const TTS_MODEL = 'gemini-3.8-flash-tts';
export const GEMINI_URGENT_STYLE =
  'panicked, desperate shouting at the top of the voice; very fast, every phrase strongly stressed, breathless urgent intonation (forceful but never insulting)';

// 고를 수 있는 목소리 — Gemini 이름(Sulafat Warm · Zephyr Bright · Kore Firm). Android TTS는 같은 순서 번호로 폰의 한국어 목소리를 고름
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
  coachMax?: UrgencyLevel; // 가장 강한 단계 상한 — 기본 4 (긴급은 실제 지각 위험일 때만)
  escalate?: boolean; // 미루기 · 지각 위험에 따라 말투 강화 (기본 켬). 끄면 늘 1단계
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
    coachMax: prefs.coachMax ?? DEFAULT_COACH_MAX,
    escalate: prefs.escalate ?? true,
    personal: prefs.personal ?? true,
    manual: { voice: prefs.voice != null, tone: prefs.tone != null },
  };
}

// ---------------------------------------------------------------------------
// 지각 위험 — 기존 출발 여유 계산(calc/depart.ts departSlack: 약속 − 이동 − (지금 + 남은 준비), 분 반올림)을 그대로 씀
//   기상: 남은 여유 = 약속 − 지금 − 준비 − 이동 / 출발: 약속 − 지금 − 이동
// ---------------------------------------------------------------------------

export const SLACK_SAFE_OVER = 30; // 이 분 초과면 여유
export const SLACK_CAUTION_OVER = 15; // 15 초과 ~ 30 이하 주의
export const SLACK_DANGER_OVER = 5; // 5 초과 ~ 15 이하 위험, 5 이하 긴급

export type LateRisk = 'SAFE' | 'CAUTION' | 'DANGER' | 'URGENT' | 'UNKNOWN' | 'DONE';

export type SlackInput = { kind: BriefKind; appointmentAtMs: number | null; prepMinutes: number | null; travelMinutes: number | null };

const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;

/** 남은 여유(분). 약속 시각 · 이동(기상이면 준비도)을 모르면 null = UNKNOWN (임의로 단정하지 않음) */
export function slackMinutes(s: SlackInput, nowMs: number): number | null {
  if (s.appointmentAtMs == null || !Number.isFinite(s.appointmentAtMs) || !known(s.travelMinutes)) return null;
  if (s.kind === 'WAKE' && !known(s.prepMinutes)) return null;
  return departSlack({
    appointmentAt: new Date(s.appointmentAtMs),
    travelMinutes: s.travelMinutes,
    now: new Date(nowMs),
    remainingMinutes: s.kind === 'WAKE' ? (s.prepMinutes as number) : 0,
  }).slackMinutes;
}

/** done = 이미 출발했거나(출발 기록) 기상 알람인데 이미 기상 확인함 → 지각 위험을 따지지 않음 */
export function lateRisk(slack: number | null, done = false): LateRisk {
  if (done) return 'DONE';
  if (slack == null) return 'UNKNOWN';
  if (slack > SLACK_SAFE_OVER) return 'SAFE';
  if (slack > SLACK_CAUTION_OVER) return 'CAUTION';
  if (slack > SLACK_DANGER_OVER) return 'DANGER';
  return 'URGENT';
}

/** 단계 — 실제 긴급이면 4(미루기 없이도), 아니면 미루기로 1 · 2 · 3 (미루기만으로는 4가 안 됨). 사용자 상한을 넘지 않음 */
export function speechLevel(snoozeCount: number, risk: LateRisk, maxLevel: UrgencyLevel): UrgencyLevel {
  const level = risk === 'URGENT' ? 4 : Math.min(Math.max(0, snoozeCount) + 1, 3);
  return Math.max(1, Math.min(level, maxLevel)) as UrgencyLevel;
}

// ---------------------------------------------------------------------------
// 폰(네이티브)에 넘기는 규칙 — 울릴 때 네트워크 없이 단계를 정하려고 "긴급이 되는 시각"을 미리 계산
//   slack(반올림) ≤ 5 ⇔ 정확한 여유 < 5.5분 ⇔ 지금 > urgentAtMs. 네이티브 SpeechUrgency.kt는 이 비교만 함 (spec/urgency-cases.json으로 둘 다 확인)
// ---------------------------------------------------------------------------

export type UrgencyRule = { urgentAtMs: number | null; maxLevel: UrgencyLevel };

export function urgentAtMs(s: SlackInput): number | null {
  if (s.appointmentAtMs == null || !Number.isFinite(s.appointmentAtMs) || !known(s.travelMinutes)) return null;
  if (s.kind === 'WAKE' && !known(s.prepMinutes)) return null;
  const used = s.travelMinutes + (s.kind === 'WAKE' ? (s.prepMinutes as number) : 0);
  return s.appointmentAtMs - (used + SLACK_DANGER_OVER + 0.5) * 60_000;
}

export function urgencyRule(s: SlackInput, profile: Pick<VoiceProfile, 'coachMax' | 'escalate'>): UrgencyRule {
  return { urgentAtMs: urgentAtMs(s), maxLevel: profile.escalate ? profile.coachMax : 1 };
}

/** 네이티브와 같은 식 — 미리 계산한 규칙으로 울릴 때의 단계 */
export function levelAt(rule: UrgencyRule, snoozeCount: number, nowMs: number): UrgencyLevel {
  const urgent = rule.urgentAtMs != null && nowMs > rule.urgentAtMs;
  return speechLevel(snoozeCount, urgent ? 'URGENT' : 'SAFE', rule.maxLevel);
}

/** 한 울림의 엔진 — 긴급이고 Gemini 음성이 준비돼 있을 때만 Gemini, 아니면 Android TTS로 전체 브리핑 */
export function engineFor(level: UrgencyLevel, hasGeminiClip: boolean): 'GEMINI' | 'ANDROID' {
  return level === 4 && hasGeminiClip ? 'GEMINI' : 'ANDROID';
}

// 기상 알람은 미루기(최대 3번 × 15분)와 다시 울림 사이에 긴급이 될 수 있음 → 그 안에 긴급 시각이 있으면 Gemini 음성을 미리 만듦. 출발 알람은 미루기가 없어 울리는 순간만
export const GEMINI_WINDOW_MIN: Record<BriefKind, number> = { WAKE: 60, DEPARTURE: 1 };

/** Gemini 음성이 필요한지 — 긴급(4단계)이 허용되고, 이 알람이 울리는 동안 실제로 긴급이 될 수 있을 때만 (스누즈 3번이어도 여유가 있으면 안 만듦) */
export function needsGemini(rule: UrgencyRule, kind: BriefKind, ringAtMs: number): boolean {
  return rule.maxLevel >= 4 && rule.urgentAtMs != null && rule.urgentAtMs < ringAtMs + GEMINI_WINDOW_MIN[kind] * 60_000;
}

/** 미리 만들 단계 — 1 ~ 상한 */
export function levelsToPrepare(rule: UrgencyRule): UrgencyLevel[] {
  return ([1, 2, 3, 4] as const).filter((l) => l <= rule.maxLevel);
}

// Android TTS 높낮이 · 속도 (1.0 = 기본) — 말투(중요도 기본값 또는 직접 고름)가 바탕, 단계가 올라갈수록 높고 빠르게
const TONE_BASE: Record<ToneKey, { pitch: number; rate: number }> = {
  GENTLE: { pitch: 0.95, rate: 0.9 },
  NORMAL: { pitch: 1.0, rate: 1.0 },
  FIRM: { pitch: 1.05, rate: 1.1 },
};
const LEVEL_BOOST: Record<UrgencyLevel, { pitch: number; rate: number }> = {
  1: { pitch: 0, rate: 0 },
  2: { pitch: 0.05, rate: 0.1 },
  3: { pitch: 0.1, rate: 0.2 },
  4: { pitch: 0.15, rate: 0.35 },
};

export type AndroidVoice = { pitch: number; rate: number; voiceIndex: number };

export function androidVoice(profile: Pick<VoiceProfile, 'voice' | 'tone'>, level: UrgencyLevel): AndroidVoice {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    pitch: r2(TONE_BASE[profile.tone].pitch + LEVEL_BOOST[level].pitch),
    rate: r2(TONE_BASE[profile.tone].rate + LEVEL_BOOST[level].rate),
    voiceIndex: Math.max(0, VOICES.findIndex((v) => v.id === profile.voice)),
  };
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
  return strong ? `${t}에는 나가야 해!!` : `${t}에는 나가야 하니까`;
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
    m.wakeEarly ? '너 어제 일찍 일어나고 싶다며!!!!!!!' : null,
    m.lateByOversleep ? '늦잠 자서 지각했다고 반성했잖아!!!! 또 지각할 거야?!?!' : null,
    m.lateByOversleep || m.wakeEarly ? '어제 다짐했으면 오늘 실천해야지!!!!!!!' : null,
  ].filter((s): s is string => s != null);
}

function quickSchedule(input: BriefingInput): string | null {
  const appts = input.appointments.slice(0, 2).map((a) => apptLine(a, input.timeZone));
  return appts.length ? `오늘 ${list(appts)} 있잖아` : null;
}

// 2 · 3단계는 상한 때문에 긴급에서 내려온 경우도 있어 "미뤘다" 같은 사실은 단정하지 않음. 4단계는 실제 여유 5분 이하일 때만이라 "늦는다"고 말함
function wakeText(level: UrgencyLevel, input: BriefingInput): (string | null)[] {
  if (level === 1) {
    const depart = departSentence(input, false);
    return ['좋은 아침이야~', ...memoGentle(input.memo), scheduleSentence(input), importantSentence(input), ...todoSentences(input), depart ? `${depart} 슬슬 일어나서 준비해 볼까?` : '슬슬 일어나서 준비해 볼까?'];
  }
  if (level === 2) {
    return ['야! 이제 진짜 일어나야 해. 더 미루면 준비가 빠듯해져.', ...memoFirm(input.memo), scheduleSentence(input), importantSentence(input), '지금 일어나자. 계속 잘 거야?'];
  }
  if (level === 3) {
    const quick = quickSchedule(input);
    return ['야!! 이제 정말 일어나!! 더 미루면 안 돼!!', ...memoFirm(input.memo), quick ? `${quick}!!` : null, departSentence(input, true), '바로 일어나서 준비해!!'];
  }
  const quick = quickSchedule(input);
  return ['야!!!!!!!!!! 지금 안 일어나면 진짜 늦어!!!!', ...memoShout(input.memo), quick ? `${quick}!!!!` : null, '지금 당장 일어나!!!!!!!'];
}

function departureText(level: UrgencyLevel, input: BriefingInput): (string | null)[] {
  const a = input.appointments[0];
  const what = a ? apptLine(a, input.timeZone) : null;
  const items = titles(input.todos, 'ITEM');
  if (level === 1) return [what ? `${what} 갈 시간이야.` : '나갈 시간이야.', items.length ? `챙길 것: ${list(items)}.` : null, '이제 출발하자!'];
  if (level === 2) return [what ? `${what}, 늦지 않게 지금 나가야 해!` : '늦지 않게 지금 나가야 해!', items.length ? `챙길 것: ${list(items)}.` : null, '바로 출발해!'];
  if (level === 3) return ['야!! 지금 바로 나가!!', what ? `${what} 있잖아!!` : null, items.length ? `챙길 것: ${list(items)}!!` : null];
  return ['야!!!!!!!! 지금 당장 나가!!!!', a ? `이러다 ${a.title.trim()} 늦는다고!!!!` : '이러다 늦는다고!!!!', items.length ? `${list(items)} 챙기고 바로 출발해!!!!!!!` : '바로 출발해!!!!!!!'];
}

/** 단계별 알람 음성 문장 — 알람이 울리는 동안 이 문장 하나를 읽음 */
export function briefingText(level: UrgencyLevel, input: BriefingInput): string {
  const parts = input.kind === 'DEPARTURE' ? departureText(level, input) : wakeText(level, input);
  return parts.filter((s): s is string => !!s).join(' ');
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

/** 단계별 문장 + Android TTS 값 + 캐시 열쇠(4단계 Gemini 음성용) */
export function briefingClips(rule: UrgencyRule, profile: Pick<VoiceProfile, 'voice' | 'tone'>, input: BriefingInput, model = TTS_MODEL): BriefingClip[] {
  return levelsToPrepare(rule).map((level) => {
    const text = briefingText(level, input);
    return { level, text, hash: clipHash({ text, voice: profile.voice, style: GEMINI_URGENT_STYLE, model }), ...androidVoice(profile, level) };
  });
}
