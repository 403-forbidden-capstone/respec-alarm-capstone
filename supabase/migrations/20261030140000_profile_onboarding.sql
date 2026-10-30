-- =====================================================================
-- 프로필 온보딩 칸 5개 (L7 PR 3)
--   ① onboarded_at                      온보딩을 끝낸 시각 — 비면 아직 안 끝남 (온보딩 판정이 아이디 대신 이 칸을 씀)
--   ② wake_sensitivity                  잠귀 한 문항 (D69) — 가벼움 · 보통 · 깊음
--   ③ wake_margin                       깨우는 여유 3단계 (D63) — 빠듯 · 보통 · 넉넉
--   ④ privacy_agreed_at · privacy_version  개인정보 동의 시각 · 동의한 문서 판 번호
-- 칸만 더함. 새 칸을 읽어 알람 강도 · 시각을 계산하는 것은 L1 몫이고, 온보딩 화면이 채우는 것은 PR 4 몫
-- 채움(backfill) 없음 — 기존 계정도 온보딩을 한 번 거치는 것이 의도 (onboarded_at이 비어 있으면 온보딩으로 보냄)
-- RLS는 그대로: profiles_update_own이 본인 행 수정을 허용하고, 칸 단위 권한 · 트리거는 새 칸을 막지 않음.
--   find_profile_by_handle · get_public_profiles는 칸 이름을 직접 적은 select라 새 칸이 남에게 안 나감
-- 파일 이름의 시각은 머지 직전에 npx supabase migration new로 다시 받음 (마이그레이션 머지 큐)
-- =====================================================================

alter table public.profiles
  add column onboarded_at      timestamptz,
  add column wake_sensitivity  text not null default 'NORMAL',
  add column wake_margin       text not null default 'NORMAL',
  add column privacy_agreed_at timestamptz,
  add column privacy_version   smallint,
  add constraint profiles_wake_sensitivity_check check (wake_sensitivity in ('LIGHT', 'NORMAL', 'HEAVY')),
  add constraint profiles_wake_margin_check check (wake_margin in ('TIGHT', 'NORMAL', 'LOOSE')),
  -- 동의 시각과 판 번호는 같이 있거나 같이 없음
  add constraint profiles_privacy_agreed_pair check ((privacy_agreed_at is null) = (privacy_version is null));

comment on column public.profiles.onboarded_at is
  '온보딩을 끝낸 시각. NULL = 아직 안 끝남 → 앱이 온보딩으로 보냄 (온보딩 판정은 아이디(handle) 대신 이 칸)';
comment on column public.profiles.wake_sensitivity is
  '잠귀 한 문항 답 (D69) — LIGHT 가벼움 · NORMAL 보통 · HEAVY 깊음. 가벼움 · 보통은 기본 알람 강도 보통, 깊음은 강. 계산 반영은 L1';
comment on column public.profiles.wake_margin is
  '깨우는 여유 3단계 (D63) — TIGHT 빠듯 · NORMAL 보통 · LOOSE 넉넉 = 지난 기록의 0.7 · 0.8 · 0.9 분위수로 깨울 시각을 잡음. 계산 반영은 L1';
comment on column public.profiles.privacy_agreed_at is
  '개인정보 수집 · 이용에 동의한 시각. NULL = 동의 기록 없음. privacy_version과 같이 있거나 같이 없음';
comment on column public.profiles.privacy_version is
  '동의한 개인정보 문서의 판 번호. NULL = 동의 기록 없음. privacy_agreed_at과 같이 있거나 같이 없음';
