// 한 사람의 일주일 — 하루씩 이어서: 밤 대화(coach) → 아침 진짜 하루(day) → 앱이 본 하루(location) → 기록 이월
//   이월되는 것: 하루 기록(기상~출발 → 최근 30건 통계 · P80), 4주 지각 수, 이동 실측, 서버 질문 기록(하루 1 · 주 3), 정정으로 바뀐 기록
//   밤 대화가 맞춘 날 d 의 알람 → 그날 진짜 하루의 알람. 기록 d 는 다음 밤의 "확인할 기록"과 학습 입력이 됨.
import { newAppState, plansFor, type AppState } from './app-state.ts';
import { runNight, type NightLog } from './coach.ts';
import { simulateTruth, type DayTruth } from './day.ts';
import type { Ledger } from './ledger.ts';
import { DEFAULT_GEO, observeDay, toDayRecord, type GeoParams, type Observation } from './location.ts';
import { loadPersonas, worldDay } from './persona.ts';
import type { DayRecord, Persona, PlanSummary, WorldDay } from './types.ts';

export interface DayArtifact {
  dayIndex: number; // 0부터
  seed: string; // 이 줄에 쓴 씨앗 ("시드/사람/날짜")
  baseSeed: string; // 시드 글자 (사람 · 날짜 앞)
  world: WorldDay;
  truth: DayTruth;
  obs: Observation;
  record: DayRecord;
  plans: Record<string, PlanSummary | undefined>;
  night: NightLog;
  geo: GeoParams;
}

export interface WeekResult {
  persona: Persona;
  app: AppState;
  days: DayArtifact[];
}

export interface WeekOptions {
  persona: Persona | string;
  days: number; // 1~7
  seed?: string;
  geo?: GeoParams;
  ledger: Ledger;
  onboardingPrepare?: number;
}

export async function runWeek(opts: WeekOptions): Promise<WeekResult> {
  const persona = typeof opts.persona === 'string' ? loadPersonas([opts.persona])[0] : opts.persona;
  const seed = opts.seed ?? 'sim';
  const geo = opts.geo ?? DEFAULT_GEO;
  const app = newAppState(persona, seed, opts.onboardingPrepare);
  const days: DayArtifact[] = [];
  for (let d = 0; d < opts.days; d++) {
    const night = await runNight(app, { dayIndex: d, ledger: opts.ledger });
    const world = worldDay(persona, d);
    const plans = plansFor(app, world);
    const truth = simulateTruth({ persona, world, plans, seed });
    const obs = observeDay({ persona, world, truth, plans, params: geo, seed });
    const record = toDayRecord(world, truth, obs, plans);
    app.worlds.push(world);
    app.records.push(record);
    days.push({ dayIndex: d, baseSeed: seed, seed: `${seed}/${persona.id}/${world.date}`, world, truth, obs, record, plans, night, geo });
  }
  return { persona, app, days };
}
