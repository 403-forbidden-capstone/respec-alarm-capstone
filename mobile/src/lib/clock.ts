// 지금 시각 — 목업 데이터 단계에서는 목업과 같은 시나리오 시각을 씀
//   아침: 5월 22일 목요일 오전 7:55 (목업 첫 화면) · 저녁: 전날 밤 9:00 (목업 데모 첫 단계)
// /dev/screens에서 바꿔 볼 수 있음. 실데이터로 바꿀 때 now()가 new Date()를 돌려주게 바꿈
export type ScenarioTime = 'morning' | 'evening';

const SCENARIO: Record<ScenarioTime, Date> = {
  morning: new Date('2025-05-21T22:55:00Z'),
  evening: new Date('2025-05-21T12:00:00Z'),
};

let current: ScenarioTime = 'morning';

export function now() {
  return SCENARIO[current];
}

export function scenarioTime() {
  return current;
}

export function setScenarioTime(next: ScenarioTime) {
  current = next;
}
