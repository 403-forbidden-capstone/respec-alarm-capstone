// 온보딩 단계 순서 · 진행 계산 — 순수 함수 (app/onboarding.tsx가 씀, 시험: __tests__/steps.test.ts)
// 켜고 끄는 표는 lib/flags ONBOARDING_STEPS. 끈 단계는 건너뛰고 진행 표시도 켠 단계만 셈
import { ONBOARDING_STEPS, type OnboardingStepId } from '@/lib/flags';

export type { OnboardingStepId };
export type StepFlags = Record<OnboardingStepId, boolean>;

// 단계 순서 한 곳 — L7 지시서 2절 표 (순서는 레인 정의 그대로)
export const ONBOARDING_ORDER: readonly OnboardingStepId[] = [
  'handle',
  'nickname',
  'sleep',
  'home',
  'prepare',
  'timetable',
  'consent',
  'permissions',
  'share',
  'first',
  'mic',
];

// 켜진 단계만, 순서 그대로
export function activeSteps(flags: StepFlags = ONBOARDING_STEPS): OnboardingStepId[] {
  return ONBOARDING_ORDER.filter((id) => flags[id]);
}

// 다음 켜진 단계. 마지막이거나 켜진 단계에 없으면 null
export function nextStep(current: OnboardingStepId, flags: StepFlags = ONBOARDING_STEPS): OnboardingStepId | null {
  const list = activeSteps(flags);
  const at = list.indexOf(current);
  return at >= 0 ? (list[at + 1] ?? null) : null;
}

// 이전 켜진 단계. 첫 단계이거나 켜진 단계에 없으면 null
export function prevStep(current: OnboardingStepId, flags: StepFlags = ONBOARDING_STEPS): OnboardingStepId | null {
  const list = activeSteps(flags);
  const at = list.indexOf(current);
  return at > 0 ? list[at - 1] : null;
}

// 진행 표시용 "n / 전체" — 켜진 단계 기준 1부터. 켜진 단계에 없으면 step 0
export function stepNumber(id: OnboardingStepId, flags: StepFlags = ONBOARDING_STEPS): { step: number; total: number } {
  const list = activeSteps(flags);
  return { step: list.indexOf(id) + 1, total: list.length };
}
