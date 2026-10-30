// 이동시간 정하기 — 상세설계서 7장 7.1.2 폴백 순서 (전체작업계획 4.1 Q1 표 "이동시간 폴백")
//   직접 입력(MANUAL)이 있으면 그 값 → 1 카카오 길찾기(API) → 2 같은 경로 실측 3건 이상의 중앙값(CACHED) → 3 좌표 직선거리 근사값 → 없음
//   · alarm-commit 길은 CACHED를 계산해서 "보여 주기만" 함. DB에 travel_source = CACHED로 쓰지 않음 (alarm-commit이 막음, D5 열림)
//     단 alarm-roll(roll.ts)은 길찾기가 안 되고 첫 알람이 12시간 안이면 내 실측 중앙값을 CACHED로 저장함
//   · 근사값(ESTIMATE)은 사용자 확인 필수 — 저장은 확인한 값을 MANUAL로 (7.1.2 단계 4)
//   · 카카오 키가 없으면(F10: 키는 받는다고 보고 만듦) 경고만 남기고 다음 단계로
// 부르는 곳을 deps로 받아서 Deno 없이 시험함 (route.test.ts)
import { estimateTravelMinutes, medianSameRoute, type LatLng, type TravelSample } from './calc/travel.ts';
import type { Transport } from './calc/types.ts';
import { KakaoError } from './kakao.ts';

export type TravelSourceKind = 'API' | 'CACHED' | 'ESTIMATE' | 'MANUAL';

export type TravelChoice = {
  minutes: number;
  source: TravelSourceKind;
  sampleCount?: number; // CACHED: 중앙값에 쓴 실측 횟수
  needsConfirmation: boolean; // ESTIMATE: 사용자가 확인해야 저장 가능
  note: string; // 화면에 보일 근거 한 줄 (7.1.2 표 "화면 표시")
};

export type Warning = {
  code: 'KAKAO_NOT_CONFIGURED' | 'KAKAO_FAILED' | 'KAKAO_PARTIAL' | 'NO_COORDINATES' | 'PAST_ALARM_DISABLED';
  message: string;
  detail?: string;
};

export type TravelDeps = {
  // 카카오로 분 단위 이동시간. 키가 없으면 undefined
  kakao?: (args: { origin: LatLng; destination: LatLng; transport: Transport }) => Promise<{ minutes: number; partial: boolean }>;
  // 내 지난 이동 기록 (출발 · 도착이 모두 찍힌 것). 안 주면 2단계를 건너뜀
  samples?: () => Promise<TravelSample[]>;
};

export type AutoTravel = { choice: TravelChoice | null; warnings: Warning[] };

export async function resolveAutoTravel(
  args: { origin?: LatLng; destination?: LatLng; transport: Transport },
  deps: TravelDeps,
): Promise<AutoTravel> {
  const warnings: Warning[] = [];
  const { origin, destination, transport } = args;
  if (!origin || !destination) {
    warnings.push({ code: 'NO_COORDINATES', message: '출발지 · 목적지 좌표가 없어서 길찾기를 못 했어요 (장소를 검색해서 골라 주세요)' });
    return { choice: null, warnings };
  }

  // 1. 카카오 길찾기
  if (deps.kakao) {
    try {
      const r = await deps.kakao({ origin, destination, transport });
      if (r.partial) warnings.push({ code: 'KAKAO_PARTIAL', message: '출발지 · 목적지 쪽 도보 구간은 빠져 있을 수 있어요' });
      return { choice: { minutes: r.minutes, source: 'API', needsConfirmation: false, note: '길찾기 기준' }, warnings };
    } catch (e) {
      const kind = e instanceof KakaoError ? e.kind : 'UNKNOWN';
      warnings.push({ code: 'KAKAO_FAILED', message: '길찾기를 못 불러왔어요', detail: kind });
    }
  } else {
    warnings.push({ code: 'KAKAO_NOT_CONFIGURED', message: '길찾기 키가 아직 설정되지 않았어요' });
  }

  // 2. 같은 경로 실측 3건 이상 → 중앙값 (카카오 응답이 아니라 내 출발 · 도착 기록이라 약관 제약 없음)
  if (deps.samples) {
    try {
      const median = medianSameRoute(await deps.samples(), origin, destination, transport);
      if (median) {
        return {
          choice: { minutes: median.minutes, source: 'CACHED', sampleCount: median.sampleCount, needsConfirmation: false, note: '최근 이동 기록을 기준으로 했어요' },
          warnings,
        };
      }
    } catch {
      // 기록을 못 읽어도 다음 단계로
    }
  }

  // 3. 직선거리 근사값 — 좌표가 있을 때만, 사용자 확인 필수
  const minutes = estimateTravelMinutes(origin, destination, transport);
  return { choice: { minutes, source: 'ESTIMATE', needsConfirmation: true, note: '대략적인 값이에요 · 확인이 필요해요' }, warnings };
}

export type ResolvedTravel = {
  chosen: TravelChoice | null; // 적용되는 값. null이면 이동시간을 구할 길이 없음(좌표도 직접 입력도 없음)
  auto: TravelChoice | null; // 직접 입력이 없을 때의 자동 값 (직접 입력이어도 미리 보기용으로 구해 둠)
  warnings: Warning[];
};

// override = 사용자가 직접 입력한 이동시간 → MANUAL. wantAuto가 거짓이면 직접 입력일 때 자동 값은 구하지 않음(호출 절약)
export async function resolveTravel(
  args: { origin?: LatLng; destination?: LatLng; transport: Transport; override?: number },
  deps: TravelDeps,
  options: { wantAuto?: boolean } = {},
): Promise<ResolvedTravel> {
  if (args.override != null) {
    const chosen: TravelChoice = { minutes: args.override, source: 'MANUAL', needsConfirmation: false, note: '직접 입력' };
    if (!options.wantAuto) return { chosen, auto: null, warnings: [] };
    const auto = await resolveAutoTravel(args, deps);
    return { chosen, auto: auto.choice, warnings: auto.warnings };
  }
  const auto = await resolveAutoTravel(args, deps);
  return { chosen: auto.choice, auto: auto.choice, warnings: auto.warnings };
}
