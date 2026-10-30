// 위치 조정 표 — 같은 진실(같은 씨앗, 같은 하루)에 위치 값만 바꿔 다시 읽어 결과를 견줌 (헤드 기준 5: 지각 경계 · 반경 · 감지 지연은 L2 코드 값이 기본, 여기서만 바꿈)
//   집 반경 150/200/300 · 목적지 반경 100/150/300(분류 구분 없이 모두) · 감지 지연 고정 1/3/6분 · 지각 경계(위치 도착) +11(코드) / +5
//   진짜 하루(DayTruth)는 그대로 두고 observeDay 만 다시 부름 → 이월(학습)은 안 따라감: 하루 단위 비교
import { DEFAULT_GEO, observeDay, type GeoParams } from './location.ts';
import type { DayArtifact } from './week.ts';
import type { Persona } from './types.ts';

export interface AdjustVariant {
  label: string;
  group: string;
  params: GeoParams;
}

const dest = (r: number): GeoParams['destRadiusM'] => ({ CAMPUS: r, AREA: r, WIDE: r, BUILDING: r, UNKNOWN: r });

export const ADJUST_VARIANTS: AdjustVariant[] = [
  { group: '기본', label: '코드 값 (집 200 · 분류별 목적지 · 지연 섞임 · 위치 +11분)', params: DEFAULT_GEO },
  { group: '집 반경', label: '150m', params: { ...DEFAULT_GEO, homeRadiusM: 150 } },
  { group: '집 반경', label: '200m', params: { ...DEFAULT_GEO, homeRadiusM: 200 } },
  { group: '집 반경', label: '300m', params: { ...DEFAULT_GEO, homeRadiusM: 300 } },
  { group: '목적지 반경', label: '100m', params: { ...DEFAULT_GEO, destRadiusM: dest(100) } },
  { group: '목적지 반경', label: '150m', params: { ...DEFAULT_GEO, destRadiusM: dest(150) } },
  { group: '목적지 반경', label: '300m', params: { ...DEFAULT_GEO, destRadiusM: dest(300) } },
  { group: '감지 지연', label: '1분 고정', params: { ...DEFAULT_GEO, delay: { mode: 'fixed', minutes: 1 } } },
  { group: '감지 지연', label: '3분 고정', params: { ...DEFAULT_GEO, delay: { mode: 'fixed', minutes: 3 } } },
  { group: '감지 지연', label: '6분 고정', params: { ...DEFAULT_GEO, delay: { mode: 'fixed', minutes: 6 } } },
  { group: '지각 경계', label: '위치 도착 +11분 (코드)', params: { ...DEFAULT_GEO, lateBoundary: 11 } },
  { group: '지각 경계', label: '위치 도착 +5분', params: { ...DEFAULT_GEO, lateBoundary: 5 } },
];

export interface AdjustRow {
  group: string;
  label: string;
  trips: number; // 이동 수 (앱이 아는 약속 + 모르는 약속)
  departRecorded: number; // 출발이 기록된 수
  arriveRecorded: number;
  avgDepartErrMin: number | null; // |기록 출발 − 진짜 출발| 평균 (분)
  avgArriveErrMin: number | null;
  appLate: number; // 앱이 지각이라 본 수
  trulyLate: number;
  misjudge: number;
  oneTap: number;
}

export function runAdjust(persona: Persona, days: readonly DayArtifact[], variants: readonly AdjustVariant[] = ADJUST_VARIANTS): AdjustRow[] {
  return variants.map((v) => {
    let trips = 0;
    let dep = 0;
    let arr = 0;
    let appLate = 0;
    let trulyLate = 0;
    let misjudge = 0;
    let oneTap = 0;
    const depErr: number[] = [];
    const arrErr: number[] = [];
    for (const d of days) {
      const obs = observeDay({ persona, world: d.world, truth: d.truth, plans: d.plans, params: v.params, seed: d.baseSeed });
      misjudge += obs.misjudgeCount;
      oneTap += obs.oneTapCount;
      for (const t of obs.trips) {
        trips++;
        if (t.trulyLate) trulyLate++;
        if (t.isLate === true) appLate++;
        if (t.recordedDepart) {
          dep++;
          if (t.trueDepart) depErr.push(Math.abs(Date.parse(t.recordedDepart) - Date.parse(t.trueDepart)) / 60_000);
        }
        if (t.recordedArrive) {
          arr++;
          if (t.trueArrive) arrErr.push(Math.abs(Date.parse(t.recordedArrive) - Date.parse(t.trueArrive)) / 60_000);
        }
      }
    }
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    return { group: v.group, label: v.label, trips, departRecorded: dep, arriveRecorded: arr, avgDepartErrMin: avg(depErr), avgArriveErrMin: avg(arrErr), appLate, trulyLate, misjudge, oneTap };
  });
}
