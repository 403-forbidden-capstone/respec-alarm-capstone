import { describe, expect, it } from '@jest/globals';

import { applyTool, buttonNote, coachLine, currentIndex, markStep, startRun } from '../run';

// 아침 루틴 음성 진행 (H09) — 순서대로만 · AI 도구 처리 · 버튼 뒤 앱 글 · 가짜 데이터 대본
const steps = ['물 한 잔', '창문 열고 불 켜기', '스트레칭'];

describe('진행 규칙', () => {
  it('오늘 이미 끝낸 단계는 끝낸 것으로 시작, 지금 단계 = 아직 안 한 첫 단계', () => {
    const s = startRun(steps, 1);
    expect(s.marks).toEqual(['done', 'todo', 'todo']);
    expect(currentIndex(s)).toBe(1);
    expect(startRun(steps, 3).finished).toBe(true);
  });

  it('지금 단계만 바뀜 — 앞 · 뒤 번호는 그대로, 마지막을 하면 끝', () => {
    let s = startRun(steps, 0);
    expect(markStep(s, 2, 'done')).toBe(s);
    s = markStep(s, 1, 'done');
    s = markStep(s, 2, 'skipped');
    expect(markStep(s, 2, 'done')).toBe(s); // 같은 단계 두 번 안 셈
    s = markStep(s, 3, 'done');
    expect([s.marks, s.finished, currentIndex(s)]).toEqual([['done', 'skipped', 'done'], true, -1]);
  });
});

describe('AI 도구 처리', () => {
  it('step_done · step_skipped는 지금 단계면 바꾸고 기록할 것(changed)과 남은 수를 답함, 아니면 ok false와 지금 단계', () => {
    const s = startRun(steps, 0);
    const a = applyTool(s, { id: 'c1', name: 'step_done', args: { step: 1 } });
    expect(a.changed).toEqual({ step: 1, mark: 'done' });
    expect(a.response).toEqual({ id: 'c1', name: 'step_done', response: { ok: true, step: 1, remaining: 2 } });
    const wrong = applyTool(a.state, { id: 'c2', name: 'step_done', args: { step: 3 } });
    expect([wrong.state, wrong.changed, wrong.response.response]).toEqual([a.state, null, { ok: false, reason: 'step 3 is not the current step', current: 2 }]);
    const skip = applyTool(a.state, { id: 'c3', name: 'step_skipped', args: { step: 2 } });
    expect(skip.state.marks).toEqual(['done', 'skipped', 'todo']);
  });

  it('routine_finished는 끝으로, 모르는 도구는 ok false', () => {
    const s = startRun(steps, 0);
    expect(applyTool(s, { id: 'c', name: 'routine_finished', args: {} }).state.finished).toBe(true);
    expect(applyTool(s, { id: 'c', name: 'dance', args: {} }).response.response).toEqual({ ok: false, reason: 'unknown function' });
  });
});

describe('버튼 뒤 앱 글 · 가짜 데이터 대본', () => {
  it('버튼 글 — 이미 기록했으니 같은 도구를 다시 부르지 말 것, 마지막이면 routine_finished', () => {
    expect(buttonNote(1, 'done', false)).toBe('[APP NOTE] The user pressed the "했어" button on screen for step 1. It is already recorded, so do not call step_done for step 1. Respond in one short sentence and present the next step.');
    expect(buttonNote(3, 'skipped', true)).toMatch(/"건너뛰기".*step_skipped for step 3\. That was the last step: call routine_finished and close\.$/);
  });

  it('대본 — 처음은 인사 · 단계 수 · 첫 단계, 다음은 받침에 맞춰 \"이에요/예요\", 끝나면 마무리', () => {
    let s = startRun(steps, 0);
    expect(coachLine(s)).toBe('좋은 아침이에요! 오늘 루틴은 3단계예요. 먼저 물 한 잔부터 해요. 다 하면 "했어"라고 말해 주세요.');
    s = markStep(s, 1, 'done');
    expect(coachLine(s)).toBe('좋아요! 다음은 창문 열고 불 켜기예요.');
    s = markStep(s, 2, 'done');
    expect(coachLine(s)).toBe('좋아요! 다음은 스트레칭이에요.');
    expect(coachLine(markStep(s, 3, 'done'))).toBe('루틴 끝! 오늘 아침도 잘 시작했어요.');
  });
});
