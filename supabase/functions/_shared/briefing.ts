// 기상 알람 AI 음성 브리핑 — 순수 함수만 (서버 alarm-briefing · 앱 lib/alarmSync/briefing이 같이 씀, 시험: briefing.test.ts)
//   · 중요도(LOW 약 · NORMAL 중간 · HIGH 중요)별 음성 기본값 + 사용자 수동 설정(profiles.alarm_voice_prefs)이 이김
//   · 발화 긴급도 1~4단계 (중요도와 별개 — 남은 여유 · 미루기 · 최근 지각으로 울릴 때마다 정함)
//   · 전날 대화(conversation_sessions.extracted_data, structured.v1)에서 사용자가 직접 말한 다짐 · 반성만 꺼냄 (AI 다시 안 부름)
//   · 알람이 울릴 때 읽을 문장 = 다짐 + 오늘 일정 브리핑을 단계별로 한 흐름으로
// 알람 볼륨 · 진동 · 배경음은 여기서 안 정함 — 기존 알람 축(calc/intensity.ts, H03 수동 선택)이 그대로 정하고, 음성 단계가 바꾸지 않음
import { formatKoSpokenTime } from './tz.ts';

export type Importance = 'LOW' | 'NORMAL' | 'HIGH';
export type UrgencyLevel = 1 | 2 | 3 | 4;
export type ToneKey = 'GENTLE' | 'NORMAL' | 'FIRM';

// TTS 모델 — Gemini 3.8 Flash TTS (aistudio.google.com/docs/speech-generation, 11/10 확인: 한국어 지원 · 24kHz WAV · speech_metadata.style로 감정 · 속도 지시)
export const TTS_MODEL = 'gemini-3.8-flash-tts';

// 고를 수 있는 AI 목소리 — Gemini 기본 음성 30종 중 알람에 맞는 6개 (문서의 성격 설명 그대로)
export const VOICES: readonly { id: string; label: string }[] = [
  { id: 'Sulafat', label: '따뜻한' },
  { id: 'Achernar', label: '부드러운' },
  { id: 'Zephyr', label: '밝은' },
  { id: 'Puck', label: '경쾌한' },
  { id: 'Kore', label: '단호한' },
  { id: 'Fenrir', label: '활기찬' },
];

// 말투 3종 — style은 TTS에 넘기는 지시(영어가 모델에 가장 잘 먹힘, 문서 권장). 1단계(평소 기상)에만 쓰고 2~4단계는 URGENCY_STYLE이 덮음
export const TONES: Record<ToneKey, { label: string; style: string }> = {
  GENTLE: { label: '다정하고 차분하게', style: 'warm, gentle and affectionate; relaxed, slow and calm pace, soft delivery' },
  NORMAL: { label: '밝고 또렷하게', style: 'bright, clear and friendly but proactive; normal pace with crisp articulation' },
  FIRM: { label: '힘 있고 단호하게', style: 'strong, firm and direct; fast pace with forceful intonation' },
};

// 중요도별 개발팀 기본값 — 목소리 · 말투 (요구사항 표 그대로). 이 표만 바꾸면 기본값이 바뀜
export const IMPORTANCE_VOICE: Record<Importance, { voice: string; tone: ToneKey }> = {
  LOW: { voice: 'Sulafat', tone: 'GENTLE' },
  NORMAL: { voice: 'Zephyr', tone: 'NORMAL' },
  HIGH: { voice: 'Kore', tone: 'FIRM' },
};

// 긴급도 단계별 발화 지시 — 2~4단계는 말투보다 우선 (목소리는 그대로라 같은 사람이 점점 다급해짐)
export const URGENCY_STYLE: Record<Exclude<UrgencyLevel, 1>, string> = {
  2: 'clear, firm and insistent; brisk faster pace, no softness',
  3: 'urgent and tense, raised voice; fast pace with strong emphasis and pressing intonation',
  4: 'panicked, desperate shouting at the top of the voice; very fast, every phrase strongly stressed, breathless urgent intonation (forceful but never insulting)',
};

/** profiles.alarm_voice_prefs — 칸이 없으면 자동(개발팀 기본값). 사용자가 고른 칸만 들어 있음 → 지우면 기본값으로 돌아감 */
export type VoicePrefs = {
  enabled?: boolean; // AI 음성 브리핑 (기본 켬)
  voice?: string; // AI 목소리 (VOICES id)
  tone?: ToneKey; // AI 말투
  coachMax?: UrgencyLevel; // 강한 코칭 상한 — 기본 3. 4(비상 기상: 소리치기)는 사용자가 허용해야만
  escalate?: boolean; // 늦을 것 같으면 말투를 자동으로 강화 (기본 켬)
  personal?: boolean; // 전날 대화 내용을 알람에 넣기 (기본 켬)
};

export const DEFAULT_COACH_MAX: UrgencyLevel = 3;

/** DB jsonb를 믿지 않고 아는 칸 · 맞는 값만 남김 (모르는 목소리 · 단계는 버려서 자동으로) */
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
  manual: { voice: boolean; tone: boolean }; // 화면이 "직접 고름 / 자동" 표시와 [기본값으로]에 씀
};

/** 사용자 수동 설정 > 중요도별 기본값 */
export function resolveVoice(importance: Importance, prefs: VoicePrefs = {}): VoiceProfile {
  const base = IMPORTANCE_VOICE[importance] ?? IMPORTANCE_VOICE.NORMAL;
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
// 발화 긴급도 — 폰이 울릴 때마다 정함 (네이티브 SpeechUrgency.kt가 urgencyLevel과 같은 식, 고치면 둘 다)
//   규칙을 두 부분으로 나눔: 알람을 걸 때 정해지는 값(UrgencyRule, 서버가 계산해 폰에 저장) + 울릴 때 값(미루기 수 · 지금 · 출발 시각)
// ---------------------------------------------------------------------------

// 여유(= 출발까지 남은 분 − 준비에 필요한 분) 경계 — 작성자 판단, 이 표만 바꾸면 됨
export const SPARE_CALM_MIN = 20; // 이 이상 여유면 1단계
export const SPARE_PRESS_MIN = 10; // 이 이상이면 2단계, 밑이면 3단계
export const SPARE_EMERGENCY_MIN = 5; // 4단계 조건: 여유가 이보다 적음 (지각 임박 · 시간 부족)
export const LATE_BUMP_COUNT = 2; // 최근 4주 지각이 이만큼이면 한 번만 미뤄도 2단계 (calc/intensity LATE_COUNT_THRESHOLD와 같은 값)

export type UrgencyRule = {
  prepMinutes: number; // 준비에 필요한 분 (참여 조건 prepare_minutes). 출발 시각은 이미 이동 · 여유를 뺀 값
  lateBump: boolean; // 최근 지각이 잦음
  allow4: boolean; // 4단계 가능 = 중요(HIGH) · 사용자가 4단계 허용 · 자동 강화 켬
  maxLevel: UrgencyLevel; // 자동 강화를 끄면 1, 아니면 사용자 상한
};

export function urgencyRule(args: { importance: Importance; prepMinutes: number | null; lateCount4w: number; profile: Pick<VoiceProfile, 'coachMax' | 'escalate'> }): UrgencyRule {
  const maxLevel: UrgencyLevel = args.profile.escalate ? args.profile.coachMax : 1;
  return {
    prepMinutes: Math.max(0, Math.round(args.prepMinutes ?? 0)),
    lateBump: args.lateCount4w >= LATE_BUMP_COUNT,
    allow4: args.importance === 'HIGH' && maxLevel >= 4,
    maxLevel,
  };
}

/** 울릴 때의 단계. departAtMs가 없으면(출발 알람 없음) 시간으로는 판단하지 않고 미루기만 봄 */
export function urgencyLevel(rule: UrgencyRule, snoozeCount: number, nowMs: number, departAtMs: number | null | undefined): UrgencyLevel {
  if (rule.maxLevel <= 1) return 1;
  const spare = departAtMs == null || !Number.isFinite(departAtMs) ? null : (departAtMs - nowMs) / 60_000 - rule.prepMinutes;
  let level: UrgencyLevel = spare == null || spare >= SPARE_CALM_MIN ? 1 : spare >= SPARE_PRESS_MIN ? 2 : 3;
  if ((snoozeCount >= 2 || (rule.lateBump && snoozeCount >= 1)) && level < 2) level = 2;
  // 중요한 일정이고, 미루기를 거듭했고, 여유가 거의 없거나 모자랄 때만 소리침 — 중요해도 여유가 있으면 안 소리침
  if (rule.allow4 && snoozeCount >= 2 && spare != null && spare < SPARE_EMERGENCY_MIN) level = 4;
  return Math.min(level, rule.maxLevel) as UrgencyLevel;
}

/** 미리 만들어 둘 단계 — 1 ~ 상한 (4단계는 allow4일 때만) */
export function levelsToPrepare(rule: UrgencyRule): UrgencyLevel[] {
  const top = Math.min(rule.maxLevel, rule.allow4 ? 4 : 3);
  return ([1, 2, 3, 4] as const).filter((l) => l <= top);
}

/** 단계별 TTS 발화 지시 — 1단계는 말투, 2~4단계는 긴급도 */
export function speechStyle(level: UrgencyLevel, tone: ToneKey): string {
  return level === 1 ? TONES[tone].style : URGENCY_STYLE[level];
}

// ---------------------------------------------------------------------------
// 전날 대화에서 꺼낸 기상 동기 — structured.v1에서 사용자가 직접 말했거나(stated) 확인한(confirmed) 것만. 짐작(inferred)은 안 씀
// ---------------------------------------------------------------------------

type Told = { source?: string };
// structured.v1 중 여기서 읽는 칸만 (final-core.ts Structured와 같은 모양의 일부)
export type StructuredLike = {
  schema_version?: string;
  session?: { reference_date?: string };
  goals_routine?: { goals?: ({ habit?: string; goal_text?: string } & Told)[] };
  habit_signals?: ({ habit?: string } & Told)[];
  sleep_wake?: ({ overslept?: boolean | null } & Told)[];
  schedule_outcomes?: ({ is_late?: boolean | null; causes?: string[] } & Told)[];
  other?: { safety_flag?: boolean };
};

export type WakeMemo = {
  wakeEarly: boolean; // "일찍 일어나고 싶다" 류 다짐
  overslept: boolean; // 늦잠 이야기
  lateByOversleep: boolean; // 늦잠으로 지각했다는 반성
  goals: string[]; // 그 밖의 목표 (사용자 말을 정리한 goal_text, 최대 2개)
};

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
// 오늘 일정 고르기 · 브리핑 문장
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
  memo: WakeMemo | null; // 사용자가 전날 대화를 끄면 null로 넘김
  appointments: readonly BriefAppointment[]; // pickAppointments 결과
  todos: readonly BriefTodo[];
  departAtMs: number | null; // 첫 일정 출발 시각 (출발 알람). 고정 시각이라 캐시해도 낡지 않음 — "N분 남음" 같은 움직이는 수는 음성에 안 넣음(화면이 실시간으로 보여 줌)
  timeZone: string;
};

const MAX_TODOS = 3;
const list = (xs: readonly string[]) => xs.join(', ');
const spoken = (ms: number, tz: string) => formatKoSpokenTime(new Date(ms), tz);
// "오후 3시 팀플 회의" — 시간 없는 할 일에는 시각을 붙이지 않음 (일정은 늘 시각이 있음)
const apptLine = (a: BriefAppointment, tz: string) => `${spoken(a.atMs, tz)} ${a.title.trim()}`;

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
  const items = input.todos.filter((t) => t.type === 'ITEM').map((t) => t.title.trim()).filter(Boolean).slice(0, MAX_TODOS);
  const tasks = input.todos.filter((t) => t.type === 'TASK').map((t) => t.title.trim()).filter(Boolean).slice(0, MAX_TODOS);
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

// 긴급 단계의 짧은 일정 — 가까운 2개만 "3시 팀플 회의"
function quickSchedule(input: BriefingInput): string | null {
  const appts = input.appointments.slice(0, 2).map((a) => apptLine(a, input.timeZone));
  return appts.length ? `오늘 ${list(appts)} 있잖아` : null;
}

/** 단계별 알람 음성 문장 — 알람이 울리는 순간 이 문장 하나가 기상 촉구 + 다짐 + 오늘 일정을 한 흐름으로 읽음 */
export function briefingText(level: UrgencyLevel, input: BriefingInput): string {
  const parts: (string | null)[] = [];
  if (level === 1) {
    parts.push('좋은 아침이야~', ...memoGentle(input.memo), scheduleSentence(input), importantSentence(input), ...todoSentences(input));
    const depart = departSentence(input, false);
    parts.push(depart ? `${depart} 슬슬 일어나서 준비해 볼까?` : '슬슬 일어나서 준비해 볼까?');
  } else if (level === 2) {
    parts.push('야! 이제 진짜 일어나야 해. 계속 미루면 준비 시간이 모자라.', ...memoFirm(input.memo), scheduleSentence(input), importantSentence(input));
    const depart = departSentence(input, false);
    parts.push(depart ? `${depart} 지금 일어나자. 계속 잘 거야?` : '지금 일어나자. 계속 잘 거야?');
  } else if (level === 3) {
    parts.push('야!! 이제 시간 진짜 얼마 안 남았어!! 지금 안 일어나면 늦어!!', ...memoFirm(input.memo));
    const quick = quickSchedule(input);
    if (quick) parts.push(`${quick}!!`);
    parts.push(departSentence(input, true), '바로 일어나서 준비해!!');
  } else {
    parts.push('야!!!!!!!!!!', ...memoShout(input.memo), '지금 계속 자면 늦는다고!!!!');
    const quick = quickSchedule(input);
    if (quick) parts.push(`${quick}!!!!`);
    parts.push('지금 당장 일어나!!!!!!!');
  }
  return parts.filter((s): s is string => !!s).join(' ');
}

// ---------------------------------------------------------------------------
// 캐시 열쇠 — 문장 · 목소리 · 지시 · 모델이 같으면 같은 음성이라 다시 만들지 않음. 일정 · 준비물이 바뀌면 문장이 바뀌어 열쇠도 바뀜
//   서버(Deno) · 앱(Hermes) · 시험(node)에서 같은 값이 나오게 의존성 없는 FNV-1a 64비트
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

export type BriefingClip = { level: UrgencyLevel; text: string; voice: string; style: string; hash: string };

/** 만들어 둘 단계별 문장 · 지시 · 열쇠 */
export function briefingClips(rule: UrgencyRule, profile: Pick<VoiceProfile, 'voice' | 'tone'>, input: BriefingInput, model = TTS_MODEL): BriefingClip[] {
  return levelsToPrepare(rule).map((level) => {
    const text = briefingText(level, input);
    const style = speechStyle(level, profile.tone);
    return { level, text, voice: profile.voice, style, hash: clipHash({ text, voice: profile.voice, style, model }) };
  });
}
