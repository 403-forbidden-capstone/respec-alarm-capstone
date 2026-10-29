-- =====================================================================
-- DB 보완 ② 위치 감지 칸 (L2 위치 · 출발 · 도착 자동, 이슈 #40 — 1단계 DB)
--   ① 출발 · 도착 시각의 출처     appointment_participants.departed_source · arrived_source
--   ② 위치 반경                   appointments.dest_radius_m · profiles.home_radius_m
--   ③ 고친 값 기록 화면 값 추가    user_edit_logs.screen에 H01 · H08 · NTF
-- 앱이 읽는 쪽(출처로 응답/위치 구분)은 다음 PR에서 바꿈 — 이 파일은 칸 · 제약만 추가
-- 새 칸은 모두 RLS 정책 · 권한이 이미 테이블 단위로 열려 있어 따로 열 것이 없음
--   (칼럼 단위 GRANT 없음 · keep_keys 트리거는 주인 · 연결 칼럼만 막음)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 출발 · 도착 시각의 출처 — 원탭(BUTTON) · 위치(LOCATION) · 직접(MANUAL)
-- ---------------------------------------------------------------------
-- 지금은 응답 시각과 같은 alarm_events 기록이 있는지로 응답/위치를 짐작함 (participantTimes loadResponseTimes) —
-- 지오펜스가 붙으면 위치 값과 응답 값이 섞이므로 시각 옆에 출처를 같이 둠
-- 출처 값은 alarm_events.input_source와 같은 enum. NULL = 기록 없음, 또는 출처 칸을 모르는 옛 앱이 쓴 원탭 값(시각만 있음 → BUTTON으로 읽음)

alter table public.appointment_participants
  add column departed_source public.event_input_source,
  add column arrived_source  public.event_input_source;

comment on column public.appointment_participants.departed_source is '출발 시각(departed_at)의 출처 — 원탭 BUTTON · 위치 LOCATION · 직접 MANUAL. 응답이 위치를 덮음(participantTimes decideWrite). 시각 없이 출처만은 안 됨, 시각만 있으면 옛 앱 원탭 값(BUTTON으로 읽음)';
comment on column public.appointment_participants.arrived_source  is '도착 시각(arrived_at)의 출처 — 원탭 BUTTON · 위치 LOCATION · 직접 MANUAL. 응답이 위치를 덮음(participantTimes decideWrite). 시각 없이 출처만은 안 됨, 시각만 있으면 옛 앱 원탭 값(BUTTON으로 읽음)';

-- 이미 들어 있는 시각은 원탭 흐름(oneTap.ts)만 썼으므로 BUTTON으로 채움 (updated_at 트리거가 같이 돎 — 영향 없음)
update public.appointment_participants set departed_source = 'BUTTON' where departed_at is not null;
update public.appointment_participants set arrived_source  = 'BUTTON' where arrived_at  is not null;

-- 출처는 시각이 있을 때만: 시각을 지우면 출처도 같이 지움 (위치 값 정정 · 귀가로 출발 취소)
--   시각만 있는 행은 막지 않음 — 출처 칸을 모르는 옛 앱이 departed_at만 쓰면 짝 제약(23514)에 걸리는데,
--   앱은 이 오류를 "다시 해도 안 되는 오류"로 보고 폰 기록을 지워 원탭 출발 · 도착이 조용히 사라짐
--   (oneTap.ts isPermanentInsertError · lib/alarmSync/events.ts PERMANENT_CODES, #231 리뷰). 그런 행은 원탭 값이라 BUTTON으로 읽음
alter table public.appointment_participants
  add constraint appointment_participants_departed_source_needs_time check (departed_source is null or departed_at is not null),
  add constraint appointment_participants_arrived_source_needs_time  check (arrived_source  is null or arrived_at  is not null);


-- ---------------------------------------------------------------------
-- 2. 위치 반경 — 도착지(약속) · 집(프로필)
-- ---------------------------------------------------------------------
-- 지오펜스 반지름(미터), 100~500. NULL = 기본값 (D77 기본안: 카카오 분류로 자동 — 건물 · 가게 150, 역 · 공원 · 대형 시설 300, 집 200 /
--   D68 장소별 150~300m). 도착지 반경은 장소를 고를 때 카카오 분류로 정해 저장함(분류 자체는 저장 안 함 — D5).
--   NULL = 이 칸 전에 만든 약속 · 분류를 모를 때 → 앱 기본값. 집 아닌 출발지(appointment_participants.origin_*)는 칸 없이 앱 기본값
-- 도착지 반경은 dest_lat · dest_lng와 같은 권한 (약속을 고칠 수 있는 사람), 집 반경은 home_lat · home_lng와 같이 본인만

alter table public.appointments
  add column dest_radius_m smallint,
  add constraint appointments_dest_radius_m_range check (dest_radius_m between 100 and 500);

alter table public.profiles
  add column home_radius_m smallint,
  add constraint profiles_home_radius_m_range check (home_radius_m between 100 and 500);

comment on column public.appointments.dest_radius_m is '도착지 지오펜스 반경(미터, 100~500). 장소를 고를 때 카카오 분류로 정함 — D77 기본안: 건물 · 가게 150, 역 · 공원 · 대형 시설 300 (D68 장소별 150~300m). NULL = 앱 기본값';
comment on column public.profiles.home_radius_m     is '집 지오펜스 반경(미터, 100~500). NULL = 기본값 — D77 기본안 집 200m (D68 장소별 150~300m)';


-- ---------------------------------------------------------------------
-- 3. 고친 값 기록 — 화면 값 추가
-- ---------------------------------------------------------------------
-- H01 = 홈 감지 정정 줄 (D61), NTF = 감지 안내 알림에서 정정 (D61),
-- H08 = 기상 정정 (D61, L1 몫이지만 CHECK를 두 번 바꾸지 않으려고 한 번에 넣음)
-- 필드 이름 규칙(user_edit_logs_field_format)과 RLS는 그대로

alter table public.user_edit_logs drop constraint user_edit_logs_screen_check;
alter table public.user_edit_logs
  add constraint user_edit_logs_screen_check check (screen in ('H01', 'H03', 'H05', 'H08', 'NTF', 'S01'));

comment on column public.user_edit_logs.screen is '어느 화면에서 고쳤는지 — H01 홈 감지 정정 줄(D61) · H03 알람 설정 · H05 새 일정 확인 시트 · H08 기상 정정(D61) · NTF 감지 안내 알림에서 정정(D61) · S01 알람 조정 제안 직접 수정';
