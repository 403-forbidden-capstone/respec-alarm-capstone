-- Server-owned, consented and codebook-verified inputs for CatBoost C1/W4.
-- Legacy ml_* columns on public.profiles are user-writable and MUST NOT be trusted.
-- This table is empty by design. Do not backfill, infer, or insert placeholder codes.
create table if not exists public.prepare_ml_verified_profiles (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  ml_age_code text not null check (ml_age_code ~ '^[0-9]{1,3}$'),
  ml_education_code text not null check (ml_education_code ~ '^[0-9]{1,3}$'),
  ml_economic_code text not null check (ml_economic_code ~ '^[0-9]{1,3}$'),
  codebook_version text not null check (length(btrim(codebook_version)) between 1 and 80),
  consent_at timestamptz not null,
  verified_at timestamptz not null default now()
);

-- No SELECT/INSERT/UPDATE/DELETE policies for client roles.
-- The Edge's service_role may read only after checking auth identity, consent,
-- the verified codebook version and the server-side inference allowlist.
alter table public.prepare_ml_verified_profiles enable row level security;
revoke all on table public.prepare_ml_verified_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.prepare_ml_verified_profiles to service_role;

comment on table public.prepare_ml_verified_profiles is
  'Server-only approved CatBoost survey codes; never writable/readable by authenticated clients. Empty until official codebook mapping and explicit consent.';
comment on column public.prepare_ml_verified_profiles.codebook_version is
  'Version of officially verified training-to-application survey code mapping. Must equal PREPARE_ML_CODEBOOK_VERSION.';
