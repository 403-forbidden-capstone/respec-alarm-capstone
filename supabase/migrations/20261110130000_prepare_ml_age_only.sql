-- Age-only C1/W4: keep legacy columns for compatibility but do not require them.
-- Apply AFTER 20261110100000 and 20261110110000. Never edit a deployed migration.
-- User-provided age still requires explicit consent and a trusted, versioned
-- codebook mapping before any ML request is allowed.
alter table public.profiles
  drop constraint if exists profiles_ml_survey_consistency;
alter table public.profiles
  add constraint profiles_ml_survey_consistency check (
    (ml_age_years is null and ml_school_status is null and ml_work_status is null
      and ml_profile_consented_at is null)
    or
    (ml_age_years is not null and ml_profile_consented_at is not null)
  );

-- The Edge consumes only the server-verified age code.
-- Existing approved education/employment fields remain nullable legacy columns.
alter table public.prepare_ml_verified_profiles
  alter column ml_education_code drop not null,
  alter column ml_economic_code drop not null;

alter table public.prepare_ml_verified_profiles
  add constraint prepare_ml_verified_age_code_range
  check (ml_age_code ~ '^[1-8]$');

comment on table public.prepare_ml_verified_profiles is
  'Server-verified, consented, versioned age-code mapping for C1/W4. '
  'Legacy education/economic code columns are retained only for backward compatibility.';

comment on column public.profiles.ml_age_years is
  'Optional self-reported age requiring consent; must be mapped and verified server-side before C1/W4 use.';
