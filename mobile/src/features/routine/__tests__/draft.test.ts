import { describe, expect, it } from '@jest/globals';

import { suggestedRoutine } from '@/mocks/ai';

import { addStep, canSave, moveStep, removeStep, savedMessage, stepTimes, toggleDay, updateStep } from '../draft';

const base = () => suggestedRoutine('2025-05-22'); // 회의 전날 준비 — 수요일 21:30부터 5분 · 2분 · 3분
const names = (r: ReturnType<typeof base>) => r.steps.map((s) => s.name);

// 루틴 편집(A04) 초안 고치기 — 목업 rDay · rAdd · rStepAlarm · rSave와 같은 결과 + 순서 바꾸기 · 빼기
describe('루틴 편집', () => {
  it('단계 시각은 첫 단계부터 걸리는 시간을 차례로 더함', () => {
    expect(stepTimes(base())).toEqual(['21:30', '21:35', '21:37']);
  });

  it('단계 추가는 맨 뒤 새 단계 5분 · 알람 없음, 시각은 앞 단계 뒤', () => {
    const r = addStep(base());
    expect(r.steps[3]).toEqual({ id: 's4', name: '새 단계', minutes: 5, alarm: false });
    expect(stepTimes(r)[3]).toBe('21:40');
    expect(addStep(r).steps[4].id).toBe('s5');
  });

  it('순서를 바꾸면 시각도 다시 셈, 끝에서는 그대로', () => {
    const r = moveStep(base(), 's3', -1);
    expect(names(r)).toEqual(['회의 자료 확인', '가방에 준비물 넣기', '노트북 충전']);
    expect(stepTimes(r)).toEqual(['21:30', '21:35', '21:38']);
    const top = base();
    expect(moveStep(top, 's1', -1)).toBe(top);
    expect(moveStep(top, 's3', 1)).toBe(top);
  });

  it('단계를 빼도 마지막 하나는 남김', () => {
    let r = removeStep(base(), 's1');
    expect(names(r)).toEqual(['노트북 충전', '가방에 준비물 넣기']);
    expect(stepTimes(r)).toEqual(['21:30', '21:32']);
    r = removeStep(r, 's2');
    expect(removeStep(r, 's3')).toBe(r);
  });

  it('단계 고치기 · 받은 값은 그대로 둠', () => {
    const before = base();
    const r = updateStep(before, 's2', { alarm: true, minutes: 10, name: '충전기 꽂기' });
    expect(r.steps[1]).toEqual({ id: 's2', name: '충전기 꽂기', minutes: 10, alarm: true });
    expect(before.steps[1].alarm).toBe(false);
    expect(stepTimes(r)[2]).toBe('21:45');
  });

  it('요일은 월요일부터 순서대로, 요일이 없으면 저장 못 함', () => {
    let r = toggleDay(base(), '월');
    r = toggleDay(r, '일');
    expect(r.days).toEqual(['월', '수', '일']);
    r = toggleDay(toggleDay(toggleDay(r, '월'), '수'), '일');
    expect(r.days).toEqual([]);
    expect(canSave(r)).toBe(false);
    expect(canSave(base())).toBe(true);
  });

  it('자정을 넘기면 0시부터', () => {
    expect(stepTimes({ ...base(), startMinute: 23 * 60 + 58 })).toEqual(['23:58', '00:03', '00:05']);
  });

  it('저장 안내 — 켜 두면 알람 개수 · 첫 요일, 꺼 두면 꺼 둔 상태', () => {
    expect(savedMessage(base())).toBe('저장했어요 · 루틴 알람 1개가 다음 수요일부터 울려요');
    expect(savedMessage({ ...base(), active: false })).toBe('저장했어요 · 루틴은 꺼 둔 상태예요');
  });
});
