import { describe, expect, it } from '@jest/globals';

import {
  EMPTY_PREPARE_ML_SURVEY,
  isCompletePrepareMlSurvey,
  HOLIDAY_PATTERN_OPTIONS,
  isHolidayPatternCode,
  prepareMlSurveySummary,
} from '../prepareMlSurvey';

describe('voluntary preparation ML survey', () => {
  it('does not treat missing answers as a valid profile', () => {
    expect(isCompletePrepareMlSurvey(EMPTY_PREPARE_ML_SURVEY)).toBe(false);
    expect(prepareMlSurveySummary(EMPTY_PREPARE_ML_SURVEY)).toBe('입력 안 함');
  });

  it('requires only a valid integer age, not education or employment', () => {
    const complete = { ml_age_years: 24, ml_school_status: 'UNIVERSITY', ml_work_status: 'NOT_WORKING' } as const;
    expect(isCompletePrepareMlSurvey(complete)).toBe(true);
    expect(isCompletePrepareMlSurvey({ ...complete, ml_age_years: 13 })).toBe(false);
    expect(isCompletePrepareMlSurvey({ ...complete, ml_age_years: 101 })).toBe(false);
    expect(isCompletePrepareMlSurvey({ ...complete, ml_age_years: 20.5 })).toBe(false);
    expect(isCompletePrepareMlSurvey({ ...complete, ml_school_status: null, ml_work_status: null })).toBe(true);
  });

  it('matches the six official 2024 weekly-rest categories, never public-holiday dates', () => {
    expect(HOLIDAY_PATTERN_OPTIONS.map(([code]) => code)).toEqual(['1','2','3','4','5','6']);
    expect(isHolidayPatternCode('1')).toBe(true);
    expect(isHolidayPatternCode('6')).toBe(true);
    expect(isHolidayPatternCode('7')).toBe(false);
    expect(isHolidayPatternCode(null)).toBe(false);
    expect(EMPTY_PREPARE_ML_SURVEY.ml_holiday_code).toBeNull();
  });

  it('only reports collection when a consent timestamp exists; never claims model activation', () => {
    const complete = { ml_age_years: 24, ml_school_status: 'UNIVERSITY', ml_work_status: 'NOT_WORKING' } as const;
    expect(prepareMlSurveySummary({ ...complete, ml_profile_consented_at: null })).toBe('입력 안 함');
    expect(prepareMlSurveySummary({ ...complete, ml_profile_consented_at: '2026-11-10T00:00:00Z' })).toBe('입력됨 · 모델 미적용');
  });
});
