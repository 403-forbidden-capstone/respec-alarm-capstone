// 위치 판정에 쓰는 값 한 곳 (7장 7.13.7 · 핵심선별 A · D68, L6 안건후보 기본안)
//   실폰 측정(7.20)으로 R_geo · T_dwell 등을 정하면 이 파일만 바꿈

const MINUTE_MS = 60_000;
export const minutesMs = (m: number): number => m * MINUTE_MS;

// 출발 확정 대기 — 이탈 뒤 이만큼(분) 안에 다시 들어오면 출발이 아님 (7.13.7 T_dwell)
export const DWELL_MINUTES = 5;

// 같은 길 — 이탈 앞뒤 이만큼(분) 안에 그 출발지에서 떠나는 약속의 출발이 이미 있으면(원탭 "출발했어요" 등)
//   그 이탈은 같은 길로 보고 아무 약속에도 안 붙임 (7.20 실폰 측정 전 기본값)
export const SAME_TRIP_MINUTES = 30;

// 감시 시간창 W_geo — 출발 예정 60분 전 ~ 약속 60분 후 (7.13.7). 집은 창 없이 늘 감시 (D68)
export const WINDOW_BEFORE_DEPART_MINUTES = 60;
export const WINDOW_AFTER_APPOINTMENT_MINUTES = 60;

// 출발지 ~ 목적지가 이보다 가까우면 도착 감지 · 이동시간 끔, 출발은 살림 — L6 안건후보: 가까운 약속 감지 기본안 A
export const NEAR_TRIP_M = 500;

// 감시 영역 상한 — 안드로이드는 앱당 100개, 여유를 두고 20개 (레인 L2 10절)
export const MAX_REGIONS = 20;

// 반경(m) — L6 안건후보: 지오펜스 반경 기본안 A — 건물 · 가게 150, 역 · 공원 · 대형 시설 300, 집 200
export const HOME_RADIUS_M = 200;
export const BUILDING_RADIUS_M = 150;
export const WIDE_RADIUS_M = 300;
// 분류를 모르는 곳(반경 칸이 빈 목적지 · 집 아닌 출발지 · 분류 없는 장소)은 집과 같은 200m (7.20 실폰 측정 전 기본값)
export const UNKNOWN_RADIUS_M = 200;
// 반경 칸 범위 (dest_radius_m · home_radius_m 100~500)
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 500;

// 감지 지연 — 안드로이드 보통 2분 이내 · 최대 6분 (핵심선별 A)
export const DETECTION_DELAY_MAX_MINUTES = 6;

// 위치로 잡은 도착의 지각 보류 구간 — L6 안건후보: 위치 도착 지각 경계 폭 기본안 A
//   약속 −2 ~ +11분 보류(+5분 지각 기준 + 최대 감지 지연 6분), +11분 넘으면 자동 지각
//   participantTimes judgeArrival이 PR3에서 씀 (지금 코드는 −2 ~ +5분)
export const LOCATION_HOLD_BEFORE_MINUTES = 2;
export const LOCATION_HOLD_AFTER_MINUTES = 11;

// 등록 직후 이만큼(분) 안의 첫 신호는 "이미 안 · 밖" 알림 — 상태만 씀. 최대 감지 지연 6분 + 여유 (7.20 실폰 측정 전 기본값)
export const INITIAL_SIGNAL_GRACE_MINUTES = 10;

// 폰에 둔 판정 기억(출발 · 도착 · 지운 값)은 약속 뒤 이만큼(시간) 지나면 버림 (근거 없음 — 작성자 판단)
export const KEEP_RECORD_HOURS = 24;
