// 지금 시각 — 가짜 데이터 모드에서는 목업과 같은 시나리오 시각, 실데이터 모드에서는 실제 시각
//   아침: 5월 22일 목요일 오전 7:55 (목업 첫 화면) · 저녁: 전날 밤 9:00 (목업 데모 첫 단계)
// 시나리오는 /dev/screens에서 바꿔 봄. 모드는 lib/mode.ts가 바뀔 때마다 setRealTime으로 알려 줌
export type ScenarioTime = 'morning' | 'evening';

const SCENARIO: Record<ScenarioTime, Date> = {
  morning: new Date('2025-05-21T22:55:00Z'),
  evening: new Date('2025-05-21T12:00:00Z'),
};

let current: ScenarioTime = 'morning';
let realTime = false;

export function now() {
  return realTime ? new Date() : SCENARIO[current];
}

export function scenarioTime() {
  return current;
}

export function setScenarioTime(next: ScenarioTime) {
  current = next;
}

// lib/mode.ts만 부름 — 실데이터 모드면 true
export function setRealTime(on: boolean) {
  realTime = on;
}
