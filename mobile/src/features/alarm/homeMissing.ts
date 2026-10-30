// 새 일정 계산이 "집 위치를 몰라서" 막혔는지 판정 — H05 안내 카드를 띄울지 (화면 없이 시험할 수 있게 뺌)
// 서버의 manual_required는 출발지(집)가 원인일 때도 도착 장소 탓처럼 나옴 (realPlan.ts estimateAppointment) — 장소 좌표가 있는데 집이 없을 때만 원인이 집
import { UserError } from '@/lib/errors';

// realPlan.ts · travelConfirm.ts의 두 문구 모두 이 말을 포함
const NO_LOCATION = '위치를 몰라';

export function isHomeMissing({ error, hasHome, placeHasCoords }: { error: unknown; hasHome: boolean; placeHasCoords: boolean }): boolean {
  return error instanceof UserError && error.message.includes(NO_LOCATION) && !hasHome && placeHasCoords;
}
