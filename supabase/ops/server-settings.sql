-- 서버 전용 설정 표(M7, 20261115090000_server_settings.sql) 운영 SQL — 예측 켜기 조건을 SQL 편집기에서 바꿈 (운영 조작 · 마이그레이션 아님)
-- 어디서: Supabase 대시보드 → SQL Editor. 아래 문장을 하나씩 골라 실행 (통째로 붙여 실행하지 않음 — 값 바꾸기 문장이 섞여 있음)
-- 누가: 예측 켜기 조건의 주인(혜린님). 서버 env 파일 · SSH는 안 건드림
-- 반영: 서버가 이 표를 읽어 약 1분 안에 반영 (서버 `/health/deep`의 예측 설정 항목에 켜짐 · 코드북 판 · 허용 계정 수가 보임)
-- 서버로 넘어가기 전에는 이 표를 아무도 안 읽음 (Edge가 계산하는 동안은 Edge 비밀 PREPARE_ML_* 가 기준). 서버로 넘어간 동안은
--   되돌리기를 대비해 Edge 비밀도 같은 값으로 맞춰 둠 (2-6 복귀 때 확인)
-- 서버로 넘기기 전에 (server_routes를 canary · server로 바꾸기 전, 2-4 ~ 2-6): 이 표를 지금 Edge 비밀 PREPARE_ML_ENABLED · PREPARE_ML_ALLOWED_USER_IDS · PREPARE_ML_CODEBOOK_VERSION 값으로 채움.
--   표는 전부 꺼짐으로 시작하므로 안 채우고 넘기면 승인한 계정이 서버 쪽에서만 조용히 P80이 됨(Edge · 서버 응답이 그 계정에서 달라짐).
--   값은 Edge 비밀을 정한 쪽(혜린님)에게 받아 아래 문장으로 같은 순서(허용 계정 → 판 → 켜짐)로 넣고, 채운 뒤 select로 세 줄이 Edge 비밀과 같은지 확인
-- 틀린 모양(UUID가 아닌 글자 · enabled가 0 · 1이 아님 · 모르는 키)은 표가 막고 server_settings_* 제약 이름이 오류에 나옴

-- 지금 값 보기 (읽기 전용)
select key, value, updated_at from public.server_settings order by key;

-- 허용 계정 하나만 켜기 (UUID는 따옴표 안에, 쉼표로 여러 개 이을 수 있음. 비우면 아무도 안 됨)
--   update public.server_settings set value = '<허용할 user_id>' where key = 'prepare_ml_allowed_user_ids';
--   update public.server_settings set value = '<코드북 판 이름>' where key = 'prepare_ml_codebook_version';
--   update public.server_settings set value = '1' where key = 'prepare_ml_enabled';

-- 끄기 (급할 때 이 한 줄이면 서버가 약 1분 안에 예측을 멈추고 P80으로 돌아감)
--   단, canary 중(계정 일부만 서버)이거나 Edge로 되돌린 뒤에는 Edge 비밀이 기준이라 표만 끄면 Edge 쪽 예측은 계속됨 → Edge 비밀 PREPARE_ML_ENABLED도 0으로 바꿔야 꺼짐
--   update public.server_settings set value = '0' where key = 'prepare_ml_enabled';

-- 허용 계정을 비움
--   update public.server_settings set value = '' where key = 'prepare_ml_allowed_user_ids';

-- 원복 (이 표를 없앰 — 서버가 표를 못 읽으면 꺼짐으로 동작해야 함. 서버 코드가 이 표를 읽기 시작한 뒤에는 쓰지 않음)
--   drop table public.server_settings;
