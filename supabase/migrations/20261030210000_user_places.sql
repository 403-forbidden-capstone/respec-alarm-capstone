-- =====================================================================
-- 자주 가는 곳 (user_places) — 학교 · 회사 · 알바 등 최대 5개 (지도에서 위치 고르기 ②, 이슈 #31)
--   헤드 설계 10/30 "집 · 회사 위치를 지도로": 집은 지금처럼 profiles(home_*), 학교 · 회사 · 알바 등은 이 표
--   위치는 누구에게도 공유하지 않음 (Q13 · D59): 친구 · 그룹 읽기 정책 없음, 본인만 읽고 씀
--   앱이 읽는 쪽(features/location/api.ts의 listUserPlaces · saveUserPlace · deleteUserPlace)은 같은 PR
-- 번호: 20261030210000 — main 최신(#313 20261030200000) 다음 칸 (처음 190000 → #313이 먼저 머지돼 바꿈)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 표
-- ---------------------------------------------------------------------
-- label: 사용자가 붙인 이름표 (예 학교 · 회사 · 알바). 한 사람 안에서 겹치지 않음 → 같은 label로 저장하면 덮어씀(upsert)
-- name · address: 지도에서 고른 장소의 이름 · 주소. 좌표는 profiles.home_lat 같은 numeric(9, 6)
-- radius_m: 지오펜스 반경(미터), appointments.dest_radius_m · profiles.home_radius_m과 같은 100~500. NULL = 앱 기본값

create table public.user_places (
  place_id   uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (user_id) on delete cascade,   -- 계정 삭제 때 같이 지움 (Q7)
  label      text not null,
  name       text not null,
  address    text,
  lat        numeric(9, 6) not null,
  lng        numeric(9, 6) not null,
  radius_m   smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_places_user_label_key unique (user_id, label),
  constraint user_places_label_length check (char_length(label) between 1 and 20),
  constraint user_places_name_not_blank check (char_length(btrim(name)) > 0),
  constraint user_places_lat_range check (lat between -90 and 90),
  constraint user_places_lng_range check (lng between -180 and 180),
  constraint user_places_radius_m_range check (radius_m between 100 and 500)
);

comment on table public.user_places is '자주 가는 곳 — 학교 · 회사 · 알바 등 한 사람 최대 5개 (헤드 설계 10/30). 집은 profiles. 위치는 공유하지 않아(Q13 · D59) 본인만 읽고 씀';
comment on column public.user_places.label    is '사용자가 붙인 이름표 (예 학교 · 회사 · 알바), 1~20자, 한 사람 안에서 겹치지 않음 — 같은 label로 저장하면 덮어씀';
comment on column public.user_places.name     is '지도나 검색에서 고른 장소 이름 (예 한국대학교 정문)';
comment on column public.user_places.radius_m  is '지오펜스 반경(미터, 100~500). NULL = 앱 기본값 (D77)';


-- ---------------------------------------------------------------------
-- 2. updated_at 자동 갱신 · 5개 제한
-- ---------------------------------------------------------------------

create trigger set_updated_at before update on public.user_places
  for each row execute function public.set_updated_at();

-- 한 사람 최대 5개 — 6번째 새 label이면 거부 (오류 코드 54000 program_limit_exceeded)
--   같은 label이 이미 있으면 덮어쓰기(upsert)라 새 행이 아니므로 통과시킴 (BEFORE INSERT는 충돌을 보기 전에 돌기 때문에 여기서 가림)
--   SECURITY INVOKER: 본인 행만 보이는 RLS 아래에서 본인 개수를 셈. 동시에 두 개를 넣어도 넘지 않게 사용자별 잠금을 건 뒤 셈
create function private.enforce_user_places_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('user_places:' || new.user_id::text, 0));

  if exists (select 1 from public.user_places p where p.user_id = new.user_id and p.label = new.label) then
    return new;
  end if;

  if (select count(*) from public.user_places p where p.user_id = new.user_id) >= 5 then
    raise exception '자주 가는 곳은 5개까지 저장할 수 있음' using errcode = '54000';
  end if;
  return new;
end;
$$;

-- 트리거 함수는 실행 권한이 없어도 트리거로는 돌아감
revoke execute on function private.enforce_user_places_limit() from public, anon, authenticated;

create trigger enforce_limit before insert on public.user_places
  for each row execute function private.enforce_user_places_limit();


-- ---------------------------------------------------------------------
-- 3. RLS — 본인만 (친구 · 그룹 읽기 정책 없음)
-- ---------------------------------------------------------------------

alter table public.user_places enable row level security;

create policy user_places_select_own on public.user_places
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_places_insert_own on public.user_places
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy user_places_update_own on public.user_places
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy user_places_delete_own on public.user_places
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- 권한: anon은 막고, authenticated · service_role은 읽기 · 쓰기 (행 범위는 RLS가 정함. rls.sql 8장과 같은 방식)
revoke all on public.user_places from anon, authenticated;
grant select, insert, update, delete on public.user_places to authenticated, service_role;
