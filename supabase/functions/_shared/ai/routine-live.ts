// 아침 루틴 음성 진행 — 기상 확인 뒤 루틴 화면에서 Gemini Live가 오늘 루틴을 한 단계씩 말로 안내 (자기 전 대화와 같은 Live, 지침 · 도구만 다름)
//   흐름: 기상 확인 → 루틴 화면 자동으로 → [시작] 한 번 → AI가 단계 안내 → 사용자가 \"했어\" → AI가 step_done을 부름 → 앱이 체크 · 다음 단계
//   토큰 지침 = 루틴 안내 규칙(ROUTINE_LIVE_SYSTEM) + 날짜 + 오늘 루틴 · 다음 알람 · 첫 일정(routineBriefText). 도구 셋은 토큰에 잠김(앱이 못 바꿈)
//   순수 TS — routine-live-token 함수와 node --test가 같은 코드를 씀
import { LIVE_MODEL, LIVE_SESSION_MS, liveDateNote } from './live-token.ts';

// 언어 규칙은 자기 전 대화(LIVE_SYSTEM)와 같음 — 사용자가 말하는 언어로
export const ROUTINE_LIVE_SYSTEM = [
  'You are the friendly voice coach of the Re:Spec Alarm app, guiding a university student through their morning routine right after they woke up.',
  'Language rule: always reply in the same language the user is speaking in their latest turn (Korean by default for the first sentence). If the user asks for another language, switch to it.',
  'Keep every reply short and spoken-friendly (one or two sentences). Be warm and energetic but calm.',
  'Start by greeting the user, say how many steps today\'s routine has, and present step 1 only. Then wait.',
  'Guide the steps strictly in the given order, one at a time. Never present a later step before the current one is done or skipped.',
  'When the user indicates the current step is finished (for example 했어, 다 했어, 마셨어, 끝, 응, done, in any wording or language), call the step_done function with that step number, then briefly praise and present the next step.',
  'When the user wants to skip the current step, call step_skipped with that step number, then present the next step. Never call these functions for a step you have not presented yet, and never call them twice for the same step.',
  'If the user talks about something else, answer in one short sentence and gently return to the current step. If the user says they need a moment, wait without repeating the step.',
  'After the last step is done or skipped, call routine_finished once, then close in one or two sentences using the next alarm and the first plan of the day if they are given below. Do not invent alarms or plans.',
  'A text message starting with [APP NOTE] comes from the app, not the user (for example, the user pressed a button on screen). Follow it and never read it aloud.',
  'You cannot see the screen. Never say you checked anything on the screen; the app does that when you call the functions.',
].join(' ');

export type RoutineBriefStep = { title: string; minutes: number };
export type RoutineBrief = {
  title: string;
  goal: string | null;
  steps: RoutineBriefStep[];
  nextAlarm: { type: 'PREPARE' | 'DEPARTURE'; at: string } | null; // at = ISO
  firstPlan: { title: string; at: string } | null;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// routines.steps JSON → 단계 (앱 map.ts parseSteps와 같은 모양: order · title · minutes). 못 읽는 칸은 뺌
export function parseRoutineSteps(json: unknown): RoutineBriefStep[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((raw, index) => ({ raw: raw as Record<string, unknown>, index }))
    .filter((x) => x.raw && typeof x.raw === 'object' && typeof x.raw.title === 'string' && x.raw.title.trim())
    .sort((a, b) => (finite(a.raw.order) && finite(b.raw.order) ? a.raw.order - b.raw.order : a.index - b.index))
    .map((x) => ({ title: String(x.raw.title).trim(), minutes: finite(x.raw.minutes) && x.raw.minutes > 0 ? Math.round(x.raw.minutes) : 1 }));
}

// ISO → 한국 시각 'HH:MM' (앱 사용자는 한국 시간, liveDateNote와 같은 가정)
export const kstClock = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(11, 16);

const ALARM_KO = { PREPARE: 'prepare alarm (준비 알람)', DEPARTURE: 'departure alarm (출발 알람)' } as const;

// 지침에 붙는 오늘 루틴 · 다음 알람 · 첫 일정
export function routineBriefText(b: RoutineBrief): string {
  const lines = [
    '',
    '',
    `Today's routine: "${b.title}"${b.goal ? ` (goal: ${b.goal})` : ''}, ${b.steps.length} step${b.steps.length === 1 ? '' : 's'}:`,
    ...b.steps.map((s, i) => `${i + 1}. ${s.title} (about ${s.minutes} min)`),
    b.nextAlarm ? `Next alarm after the routine: ${ALARM_KO[b.nextAlarm.type]} at ${kstClock(b.nextAlarm.at)}.` : 'No more alarms are set for this morning.',
    b.firstPlan ? `First plan of the day: "${b.firstPlan.title}" at ${kstClock(b.firstPlan.at)}.` : 'No plan is scheduled for the rest of today.',
  ];
  return lines.join('\n');
}

// 도구 — 단계 번호는 1부터 (지침의 목록과 같음)
export const ROUTINE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'step_done',
        description: 'The user finished the current routine step. Call once per step, right after the user says it is done.',
        parameters: { type: 'OBJECT', properties: { step: { type: 'INTEGER', description: 'Step number, starting at 1' } }, required: ['step'] },
      },
      {
        name: 'step_skipped',
        description: 'The user wants to skip the current routine step.',
        parameters: { type: 'OBJECT', properties: { step: { type: 'INTEGER', description: 'Step number, starting at 1' } }, required: ['step'] },
      },
      {
        name: 'routine_finished',
        description: 'Every step is done or skipped. Call once before the closing sentence.',
        parameters: { type: 'OBJECT', properties: {} },
      },
    ],
  },
];

// 토큰 요청 본문 — 자기 전 대화(liveTokenBody)와 같은 모양 + 지침 · 도구만 루틴용
export function routineLiveTokenBody(now: number, brief: string, model = LIVE_MODEL): Record<string, unknown> {
  return {
    expireTime: new Date(now + LIVE_SESSION_MS).toISOString(),
    newSessionExpireTime: new Date(now + 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: ROUTINE_LIVE_SYSTEM + liveDateNote(now) + brief }] },
      tools: ROUTINE_TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}
