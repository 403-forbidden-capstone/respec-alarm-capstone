import { describe, expect, it } from '@jest/globals';

import { IMPORTANCE_POINT, KIND_LABEL, toAlarmIntensity } from '@/features/alarm/types';
import { buildRingPackages, canceledAlarmIds, subtitleFor } from '@shared/ring-package.ts';
import { IMPORTANCE_POINT as SHARED_IMPORTANCE_POINT, LEVEL_FIELDS } from '@shared/calc/intensity.ts';
import { KIND_LABEL as SHARED_KIND_LABEL } from '@shared/calc/types.ts';

// 서버 함수와 같이 쓰는 공용 계산(supabase/functions/_shared) 경로 별칭이 앱 · jest에서 풀리는지,
// 앱에도 따로 적어 둔 값(중요도 점수 · 종류 이름 · 강도 이름)이 공용 값과 어긋나지 않는지 (한쪽만 고치면 여기서 잡힘)
describe('공용 계산 경로 별칭 (@shared)', () => {
  it('예약 꾸러미 조립을 서버와 같은 파일로 부름', () => {
    const packages = buildRingPackages({
      alarms: [
        { alarm_id: 'b', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-20T00:00:00.000Z', intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: true },
        { alarm_id: 'a', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', intensity: 'STRONG', sound_key: 'theme_urgent', snooze_limit: 3, is_enabled: true },
        { alarm_id: 'c', alarm_type: 'PREPARE', scheduled_at: '2026-10-19T23:00:00.000Z', intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: false },
      ],
      title: '팀 주간회의',
      subtitle: subtitleFor(new Date('2026-10-20T01:00:00.000Z'), '세종대학교', 'Asia/Seoul'),
    });
    expect(packages.map((p) => p.alarmId)).toEqual(['a', 'b']); // 꺼진 알람 제외 · 시각순
    expect(packages[0]).toMatchObject({ type: 'WAKE', atMillis: Date.parse('2026-10-19T22:30:00.000Z'), title: '팀 주간회의', subtitle: '오전 10:00 · 세종대학교', intensity: 'STRONG', soundKey: 'theme_urgent' });
    expect(canceledAlarmIds({ before: [{ alarm_id: 'a' }, { alarm_id: 'c' }], after: [{ alarm_id: 'a', is_enabled: true }] })).toEqual(['c']);
  });

  it('앱에 적어 둔 값이 공용 값과 같음', () => {
    expect(IMPORTANCE_POINT).toEqual(SHARED_IMPORTANCE_POINT);
    expect(KIND_LABEL).toEqual(SHARED_KIND_LABEL);
    expect(([0, 1, 2] as const).map(toAlarmIntensity)).toEqual(LEVEL_FIELDS.map((f) => f.intensity));
  });
});
