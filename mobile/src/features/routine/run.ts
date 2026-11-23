// 아침 루틴 음성 진행 (H09) — 단계 표시 · 진행 규칙 · Live 도구 처리 · 앱 글([APP NOTE]) · 가짜 데이터 대본 (순수)
//   AI(routine-live-token 지침)가 step_done · step_skipped · routine_finished를 부르면 applyTool로 화면 상태를 바꾸고 결과를 답함
//   버튼([했어] · [건너뛰기])은 markStep으로 바꾸고 buttonNote를 Live에 넣어 AI가 다음 단계로 넘어가게 함
//   순서대로만: 지금 단계(아직 안 한 첫 단계)가 아닌 번호는 무시 — 같은 단계를 두 번 세지 않게
import type { LiveToolCall, LiveToolResponse } from '@/features/voice/live';

export type StepMark = 'todo' | 'done' | 'skipped';
export type RunState = { steps: string[]; marks: StepMark[]; finished: boolean };

// 오늘 이미 끝낸 단계(홈 카드 · 단계 알람의 \"했어요\")는 끝낸 것으로 시작
export function startRun(steps: readonly string[], doneBefore: number): RunState {
  const marks = steps.map((_, i): StepMark => (i < doneBefore ? 'done' : 'todo'));
  return { steps: [...steps], marks, finished: steps.length > 0 && doneBefore >= steps.length };
}

// 지금 단계 (0부터) — 다 했으면 -1
export const currentIndex = (s: RunState) => s.marks.indexOf('todo');

// step은 1부터 (AI 지침 · 도구와 같음). 지금 단계가 아니면 그대로
export function markStep(s: RunState, step: number, mark: 'done' | 'skipped'): RunState {
  if (s.finished || step - 1 !== currentIndex(s)) return s;
  const marks = s.marks.map((m, i) => (i === step - 1 ? mark : m));
  return { ...s, marks, finished: !marks.includes('todo') };
}

export const finishRun = (s: RunState): RunState => ({ ...s, finished: true });

// Live 도구 하나 처리 — 바뀐 상태와 Live에 돌려줄 답. changed = 이번에 새로 끝낸 단계(기록할 것)
export function applyTool(s: RunState, call: LiveToolCall): { state: RunState; response: LiveToolResponse; changed: { step: number; mark: 'done' | 'skipped' } | null } {
  const reply = (response: Record<string, unknown>) => ({ id: call.id, name: call.name, response });
  if (call.name === 'routine_finished') return { state: finishRun(s), response: reply({ ok: true }), changed: null };
  if (call.name === 'step_done' || call.name === 'step_skipped') {
    const step = Number(call.args.step);
    const mark = call.name === 'step_done' ? 'done' : 'skipped';
    const next = markStep(s, step, mark);
    if (next === s) return { state: s, response: reply({ ok: false, reason: `step ${step} is not the current step`, current: currentIndex(s) + 1 }), changed: null };
    return { state: next, response: reply({ ok: true, step, remaining: next.marks.filter((m) => m === 'todo').length }), changed: { step, mark } };
  }
  return { state: s, response: reply({ ok: false, reason: 'unknown function' }), changed: null };
}

// 화면 버튼을 누른 뒤 Live에 넣는 글 — 이미 기록했으니 같은 도구를 다시 부르지 말고 다음 단계로
export function buttonNote(step: number, mark: 'done' | 'skipped', last: boolean): string {
  const label = mark === 'done' ? '했어' : '건너뛰기';
  const fn = mark === 'done' ? 'step_done' : 'step_skipped';
  return (
    `[APP NOTE] The user pressed the "${label}" button on screen for step ${step}. It is already recorded, so do not call ${fn} for step ${step}. ` +
    (last ? 'That was the last step: call routine_finished and close.' : 'Respond in one short sentence and present the next step.')
  );
}

// 받침 있는 말 뒤엔 '이에요', 없으면 '예요'
const ieyo = (word: string) => {
  const code = word.trim().charCodeAt(word.trim().length - 1);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '이에요' : '예요';
};

// 가짜 데이터 대본 — 웹 미리보기에서 AI가 할 말 (실데이터는 Live가 말함)
export function coachLine(s: RunState): string {
  if (s.finished) return '루틴 끝! 오늘 아침도 잘 시작했어요.';
  const i = currentIndex(s);
  if (i < 0) return '루틴 끝! 오늘 아침도 잘 시작했어요.';
  const step = s.steps[i];
  if (!s.marks.some((m) => m !== 'todo')) return `좋은 아침이에요! 오늘 루틴은 ${s.steps.length}단계예요. 먼저 ${step}부터 해요. 다 하면 "했어"라고 말해 주세요.`;
  return `좋아요! 다음은 ${step}${ieyo(step)}.`;
}
