import { describe, expect, it } from '@jest/globals';

import { suggestedRoutine } from '@/mocks/ai';
import { kst } from '@/mocks/data';

import { addStep, canSave, moveStep, nextStart, removeStep, sameRoutine, savedMessage, startWord, stepTimes, toggleDay, updateStep } from '../draft';

const base = () => suggestedRoutine('2025-05-22'); // 회의 전날 준비 — 수요일 21:30부터 5분 · 2분 · 3분
const names = (r: ReturnType<typeof base>) => r.steps.map((s) => s.name);
const THU_MORNING = kst(22, 7 * 60 + 55); // 시나리오 아침 — 5월 22일 목요일 오전 7:55
const THU_NIGHT = kst(22, 22 * 60);

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

  it('저장 안내 — 켜 두면 알람 개수 · 처음 울리는 날, 꺼 두면 꺼 둔 상태', () => {
    expect(savedMessage(base(), THU_MORNING)).toBe('저장했어요 · 루틴 알람 1개가 다음 수요일부터 울려요');
    expect(savedMessage({ ...base(), active: false }, THU_MORNING)).toBe('저장했어요 · 루틴은 꺼 둔 상태예요');
    expect(savedMessage({ ...base(), days: ['금'] }, THU_MORNING)).toBe('저장했어요 · 루틴 알람 1개가 내일부터 울려요');
  });
});

// 시작하는 날 — 월요일부터 세지 않고 지금(시나리오 시각)부터 가장 가까운 고른 요일
describe('루틴 시작하는 날', () => {
  const days = (...d: ('월' | '화' | '수' | '목' | '금' | '토' | '일')[]) => ({ ...base(), days: d });

  it('고른 요일 중 지금부터 가장 가까운 날 (첫 번째로 고른 요일이 아님)', () => {
    expect(nextStart(days('수'), THU_MORNING)).toEqual({ weekday: '수', daysAhead: 6 });
    expect(nextStart(days('수', '금'), THU_MORNING)).toEqual({ weekday: '금', daysAhead: 1 }); // 목요일 → 수요일이 아니라 금요일
    expect(nextStart(days('월', '일'), THU_MORNING)).toEqual({ weekday: '일', daysAhead: 3 });
  });

  it('오늘이 고른 요일이면 시작 시각 전에는 오늘, 지났으면 다음 주', () => {
    expect(nextStart(days('목'), THU_MORNING)).toEqual({ weekday: '목', daysAhead: 0 }); // 21:30 전
    expect(nextStart(days('목'), THU_NIGHT)).toEqual({ weekday: '목', daysAhead: 7 }); // 22:00 — 이미 지남
    expect(nextStart(days('목', '금'), THU_NIGHT)).toEqual({ weekday: '금', daysAhead: 1 });
  });

  it('요일이 없으면 null · 빈 글자', () => {
    expect(nextStart(days(), THU_MORNING)).toBeNull();
    expect(startWord(days(), THU_MORNING)).toBe('');
  });

  it('말 — 오늘 · 내일 · 다음 N요일', () => {
    expect(startWord(days('목'), THU_MORNING)).toBe('오늘');
    expect(startWord(days('금'), THU_MORNING)).toBe('내일');
    expect(startWord(days('수', '토'), THU_MORNING)).toBe('다음 토요일');
  });
});

describe('고친 곳 찾기', () => {
  it('같으면 true, 이름 · 시간 · 알람 · 요일 · 단계 수가 다르면 false', () => {
    expect(sameRoutine(base(), base())).toBe(true);
    expect(sameRoutine(base(), updateStep(base(), 's1', { name: '다른 이름' }))).toBe(false);
    expect(sameRoutine(base(), updateStep(base(), 's1', { minutes: 9 }))).toBe(false);
    expect(sameRoutine(base(), updateStep(base(), 's1', { alarm: false }))).toBe(false);
    expect(sameRoutine(base(), toggleDay(base(), '월'))).toBe(false);
    expect(sameRoutine(base(), addStep(base()))).toBe(false);
    expect(sameRoutine(base(), { ...base(), active: false })).toBe(false);
  });

  it('순서를 바꿨다가 되돌리면 같음', () => {
    expect(sameRoutine(base(), moveStep(moveStep(base(), 's2', -1), 's2', 1))).toBe(true);
  });
});
