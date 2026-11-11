// Voluntary answers for future preparation-time ML research.
// Human-friendly options are NOT CatBoost/2024 Time Use Survey category codes.
export type SchoolStatus = 'MIDDLE_HIGH' | 'UNIVERSITY' | 'GRADUATE_SCHOOL' | 'NOT_ENROLLED' | 'OTHER';
export type WorkStatus = 'WORKING' | 'NOT_WORKING' | 'OTHER';
// Official 2024 survey codes for the respondent's REGULAR rest-day pattern.
// Not a public-holiday classification for the appointment date.
export type HolidayPatternCode = '1' | '2' | '3' | '4' | '5' | '6';

export const HOLIDAY_PATTERN_OPTIONS: readonly (readonly [HolidayPatternCode, string])[] = [
  ['1', '일주일에 이틀 쉼 (주 5일제 근무)'],
  ['2', '일요일 등 주 1일 + 격주 토요일 쉼'],
  ['3', '일주일에 하루 쉼'],
  ['4', '2주일에 하루 쉼'],
  ['5', '정해진 휴일 없이 수시로 쉼'],
  ['6', '기타'],
];

export type PrepareMlSurvey = {
  ml_age_years: number | null;
  ml_school_status: SchoolStatus | null;
  ml_work_status: WorkStatus | null;
  ml_holiday_code: HolidayPatternCode | null;
  ml_profile_consented_at: string | null;
};

export const SCHOOL_OPTIONS: readonly (readonly [SchoolStatus, string])[] = [
  ['MIDDLE_HIGH', '중·고등학교 재학'],
  ['UNIVERSITY', '대학교 재학'],
  ['GRADUATE_SCHOOL', '대학원 재학'],
  ['NOT_ENROLLED', '현재 학교에 다니지 않음'],
  ['OTHER', '기타'],
];

export const WORK_OPTIONS: readonly (readonly [WorkStatus, string])[] = [
  ['WORKING', '현재 일하고 있음'],
  ['NOT_WORKING', '현재 일하지 않음'],
  ['OTHER', '기타'],
];

export const EMPTY_PREPARE_ML_SURVEY: PrepareMlSurvey = {
  ml_age_years: null,
  ml_school_status: null,
  ml_work_status: null,
  ml_holiday_code: null,
  ml_profile_consented_at: null,
};

export function isHolidayPatternCode(value: unknown): value is HolidayPatternCode {
  return typeof value === 'string' && ['1', '2', '3', '4', '5', '6'].includes(value);
}

export function isCompletePrepareMlSurvey(value: Pick<PrepareMlSurvey, 'ml_age_years' | 'ml_school_status' | 'ml_work_status'>): boolean {
  // Education/employment are legacy optional inputs, not required by age-only C1/W4.
  return typeof value.ml_age_years === 'number' && Number.isInteger(value.ml_age_years) &&
    value.ml_age_years >= 14 && value.ml_age_years <= 100;
}

export function prepareMlSurveySummary(survey: PrepareMlSurvey): string {
  return survey.ml_profile_consented_at != null && isCompletePrepareMlSurvey(survey)
    ? '입력됨 · 모델 미적용'
    : '입력 안 함';
}
