import { describe, expect, it } from '@jest/globals';

import {
  EMPTY_PREPARE_ML_SURVEY,
  isCompletePrepareMlSurvey,
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

  it('only reports collection when a consent timestamp exists; never claims model activation', () => {
    const complete = { ml_age_years: 24, ml_school_status: 'UNIVERSITY', ml_work_status: 'NOT_WORKING' } as const;
    expect(prepareMlSurveySummary({ ...complete, ml_profile_consented_at: null })).toBe('입력 안 함');
    expect(prepareMlSurveySummary({ ...complete, ml_profile_consented_at: '2026-11-10T00:00:00Z' })).toBe('입력됨 · 모델 미적용');
  });
});
