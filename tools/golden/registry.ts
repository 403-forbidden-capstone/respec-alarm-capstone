// 골든이 부르는 함수 목록 — 모듈 이름(골든 파일 이름) → 서버 TS 모듈
//   Python판(서버 레포)의 모듈과 1:1로 대응: 모듈 하나 = 골든 파일 하나 = Python 시험 하나
//   함수 이름은 TS 이름 그대로 (Python은 snake_case로 옮겨도 이 이름으로 찾음)
//   `$constants`는 모듈이 내보내는 함수가 아닌 값(상수 · 표)을 한꺼번에 담은 특별한 사례
//   composite(합친 함수)는 서버가 실제로 이어 부르는 순서를 한 번에 시험하려고 둔 것 — 함수 안에서 TS 함수만 이어 부름
import * as chain from '../../supabase/functions/_shared/calc/chain.ts';
import * as depart from '../../supabase/functions/_shared/calc/depart.ts';
import * as importance from '../../supabase/functions/_shared/calc/importance.ts';
import * as intensity from '../../supabase/functions/_shared/calc/intensity.ts';
import * as order from '../../supabase/functions/_shared/calc/order.ts';
import * as prepare from '../../supabase/functions/_shared/calc/prepare.ts';
import * as recur from '../../supabase/functions/_shared/calc/recur.ts';
import * as suggest from '../../supabase/functions/_shared/calc/suggest.ts';
import * as time from '../../supabase/functions/_shared/calc/time.ts';
import * as travel from '../../supabase/functions/_shared/calc/travel.ts';
import * as types from '../../supabase/functions/_shared/calc/types.ts';
import * as validate from '../../supabase/functions/_shared/calc/validate.ts';
import * as wake from '../../supabase/functions/_shared/calc/wake.ts';
import * as commitCore from '../../supabase/functions/_shared/commit-core.ts';
import * as planCore from '../../supabase/functions/_shared/plan-core.ts';
import * as ringPackage from '../../supabase/functions/_shared/ring-package.ts';
import * as tz from '../../supabase/functions/_shared/tz.ts';

type Namespace = Record<string, unknown>;

// 서버가 미리보기에서 부르는 순서: computePlan → toSuggestion (본 레포 plan.ts · alarm-suggest)
const planCoreWithComposites: Namespace = {
  ...planCore,
  toSuggestionOfPlan: (i: planCore.PlanInputs, travelResolved: Parameters<typeof planCore.computePlan>[1], mode: planCore.PlanMode) =>
    planCore.toSuggestion(planCore.computePlan(i, travelResolved, mode), i),
  intensityReasonOf: (
    importanceValue: Parameters<typeof intensity.resolveIntensity>[0],
    lateCount4w: number,
    overrides: intensity.IntensityOverrides,
    wakeSensitivity?: intensity.WakeSensitivity,
  ) => planCore.intensityReason({ importance: importanceValue }, intensity.resolveIntensity(importanceValue, lateCount4w, overrides, wakeSensitivity)),
};

// 서버가 저장에서 부르는 순서: computePlan(save) → diffAlarms (본 레포 commit.ts · alarm-commit)
const commitCoreWithComposites: Namespace = {
  ...commitCore,
  diffAlarmsOfPlan: (i: planCore.PlanInputs, travelResolved: Parameters<typeof planCore.computePlan>[1], options: Parameters<typeof commitCore.diffAlarms>[2]) =>
    commitCore.diffAlarms(planCore.computePlan(i, travelResolved, 'save'), i.existingAlarms, options),
};

export const MODULES: Record<string, Namespace> = {
  types,
  time,
  chain,
  order,
  validate,
  depart,
  wake,
  importance,
  suggest,
  travel,
  intensity,
  prepare,
  recur,
  tz,
  'plan-core': planCoreWithComposites,
  'commit-core': commitCoreWithComposites,
  'ring-package': ringPackage,
};

// 골든 기준 소스 — 이 파일들 내용의 해시를 골든 머리말에 적음 (줄바꿈은 \n으로 맞춰서 해시)
export const SOURCE_FILES = [
  ...['chain', 'depart', 'importance', 'intensity', 'order', 'prepare', 'recur', 'suggest', 'time', 'travel', 'types', 'validate', 'wake'].map(
    (name) => `supabase/functions/_shared/calc/${name}.ts`,
  ),
  'supabase/functions/_shared/calc/index.ts',
  'supabase/functions/_shared/commit-core.ts',
  'supabase/functions/_shared/plan-core.ts',
  'supabase/functions/_shared/ring-package.ts',
  'supabase/functions/_shared/tz.ts',
];
