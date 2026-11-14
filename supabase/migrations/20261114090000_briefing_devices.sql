-- 백그라운드 기상 브리핑 갱신(#515) — 기기 전용 키
--   폰 네이티브(WorkManager)가 앱 없이 새벽에 alarm-briefing-device를 부를 때 쓰는 키. 앱 로그인 토큰(JWT)을 Kotlin이 갱신하지 않으려고 따로 둠
--   서버에는 키의 SHA-256 해시만 둠 (원문은 폰 Android Keystore로 암호화한 저장소에만). 이 키로는 본인 기상 알람 브리핑 읽기만 됨
--   한 사용자 · 한 기기에 한 줄 (다시 발급하면 해시만 바뀜 → 예전 키는 바로 못 씀). 로그아웃하면 지우고, 계정을 지우면 profiles cascade로 같이 지워짐
--   서버(service_role)만 읽고 씀 — 앱은 briefing-device 함수(로그인 토큰)로만 발급 · 폐기
create table public.briefing_devices (
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  device_id    uuid not null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, device_id)
);

comment on table public.briefing_devices is '기상 브리핑 백그라운드 갱신용 기기 키 (해시만). briefing-device가 발급 · 폐기, alarm-briefing-device가 확인';

alter table public.briefing_devices enable row level security;
revoke all on public.briefing_devices from anon, authenticated;
grant select, insert, update, delete on public.briefing_devices to service_role;
