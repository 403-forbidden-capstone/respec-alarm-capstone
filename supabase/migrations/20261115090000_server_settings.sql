-- =====================================================================
-- 서버 전용 설정 표 (M7 · 서버 완결점 2-3 — capstone/docs/서버_완결점_1112.md 9-4 · 9-7 4번)
--   알람 계산이 서버(EC2)로 넘어간 뒤에는 예측 켜기 조건(Edge 비밀 PREPARE_ML_ENABLED · _ALLOWED_USER_IDS · _CODEBOOK_VERSION)을
--   서버가 이 표에서 읽음 → 혜린님이 SSH 없이 Supabase SQL 편집기에서 계속 직접 바꿈 (서버 env 파일은 안 거침)
--   Edge는 그대로 Edge 비밀을 읽음. 서버로 넘어간 동안 되돌릴 수 있게 Edge 비밀도 같은 값으로 맞춰 둠 (2-6 복귀 때 확인)
-- 값 모양은 Edge 비밀과 같음 (서버가 같은 규칙으로 읽음): enabled '0' · '1', 허용 계정은 쉼표로 이은 UUID, 코드북 판은 글자 하나
--   비어 있거나 모양이 틀린 허용 계정 목록 · 비어 있는 코드북 판은 서버가 "꺼짐"으로 읽음 (fail closed) — 이 표의 CHECK가 틀린 모양은 처음부터 막음
-- 값은 전부 "꺼짐"으로 시작 = 적용만으로는 동작이 안 바뀜 (서버 코드는 이 표를 읽기 전까지 아무것도 안 함)
-- 키는 이 파일의 목록만 허용 (오타가 조용히 무시되지 않게). 새 설정은 마이그레이션으로 키를 늘림
-- 이 마이그레이션은 추가만 함 (기존 표 · 함수는 안 고침). 원복 = drop table public.server_settings (supabase/ops/server-settings.sql)
-- =====================================================================

create table public.server_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now(),
  constraint server_settings_known_key check (
    key in ('prepare_ml_enabled', 'prepare_ml_allowed_user_ids', 'prepare_ml_codebook_version')),
  constraint server_settings_value_by_key check (
    case key
      when 'prepare_ml_enabled' then value in ('0', '1')
      -- 비어 있거나(아무도 안 허용) 쉼표로 이은 UUID. 쉼표 앞뒤 공백은 서버가 지우고 읽음
      when 'prepare_ml_allowed_user_ids' then
        value = '' or value ~* '^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*,\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\s*$'
      -- 앞뒤 공백 없는 80자 이하 글자 (프로필 표 codebook_version과 같은 상한. 서버가 정확히 같은 글자로 비교함). 비어 있으면 예측 안 함
      when 'prepare_ml_codebook_version' then
        value !~ '^\s|\s$' and char_length(value) <= 80
      else false
    end)
);

create trigger set_updated_at before update on public.server_settings
  for each row execute function public.set_updated_at();

comment on table public.server_settings is '서버 전용 설정 — 알람 계산이 서버로 넘어간 뒤 예측 켜기 조건을 SQL 편집기에서 바꾸는 표. 키는 CHECK 목록만, 값 모양은 Edge 비밀과 같음. 서버(service_role)만 읽음 — 앱 · 일반 사용자는 읽기 · 쓰기 모두 막힘';
comment on column public.server_settings.key is 'prepare_ml_enabled = Edge 비밀 PREPARE_ML_ENABLED / prepare_ml_allowed_user_ids = PREPARE_ML_ALLOWED_USER_IDS / prepare_ml_codebook_version = PREPARE_ML_CODEBOOK_VERSION';
comment on column public.server_settings.value is 'enabled: 0 · 1 / 허용 계정: 쉼표로 이은 UUID(비우면 아무도 안 됨) / 코드북 판: 공식 매핑 판 이름(앞뒤 공백 없이, 비우면 예측 안 함). 바꾼 뒤 서버가 약 1분 안에 읽음';

-- 전부 꺼짐으로 시작 — 실제 값은 혜린님이 승인한 계정 · 판으로 SQL 편집기에서 바꿈 (런북 supabase/ops/server-settings.sql)
insert into public.server_settings (key, value) values
  ('prepare_ml_enabled', '0'),
  ('prepare_ml_allowed_user_ids', ''),
  ('prepare_ml_codebook_version', '');

alter table public.server_settings enable row level security;

revoke all on public.server_settings from anon, authenticated;
grant select, insert, update, delete on public.server_settings to service_role;
