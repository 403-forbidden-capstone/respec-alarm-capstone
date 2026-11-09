-- Survey-coded optional profile inputs for experimental CatBoost inference.
-- Do not populate or enable ml_codes_verified until the 2024 Time Use Survey
-- codebook, user consent and service-vs-survey input mapping are checked.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ml_age_code text,
  ADD COLUMN IF NOT EXISTS ml_education_code text,
  ADD COLUMN IF NOT EXISTS ml_economic_code text,
  ADD COLUMN IF NOT EXISTS ml_codes_verified boolean NOT NULL DEFAULT false;
-- Codes are preserved as text; absence is NULL. No demographic assumption.
