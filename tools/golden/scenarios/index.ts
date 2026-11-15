// 시나리오 목록 — 순서가 곧 골든 파일 안의 사례 순서. 새 시나리오는 맨 뒤에 붙임
import { basic } from './basic.ts';
import { calendarScenarios } from './calendar.ts';
import { chainScenarios } from './chain.ts';
import type { Add } from './kit.ts';
import { modelScenarios } from './model.ts';
import { planScenarios } from './plan.ts';

export const SCENARIOS: ((add: Add) => void)[] = [basic, chainScenarios, modelScenarios, calendarScenarios, planScenarios];
