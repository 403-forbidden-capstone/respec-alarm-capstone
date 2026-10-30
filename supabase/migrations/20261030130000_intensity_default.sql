-- 기본 알람 강도 = 보통 (D69, 이슈 #262) — 이미 저장된 자동 약(SOFT) 알람을 보통(NORMAL)으로 올림
--   새 규칙: 기본 보통 · 약은 사용자가 직접 고를 때만 (_shared/calc/intensity.ts autoLevel).
--   옛 규칙은 중요도 낮음(앱 라벨 '보통')을 약으로 계산해, 자동(intensity_source = 'AUTO')인데 약인 알람이 DB에 남아 있음.
--   직접 고른 알람(MANUAL)은 사용자 선택이라 건드리지 않음.
--
-- 강도 세 칸(intensity · voice_tone · sound_key)은 자동일 때 같은 단계 값으로 같이 쓰임 (LEVEL_FIELDS):
--   약 SOFT · CALM · theme_calm  →  중 NORMAL · NEUTRAL · theme_default
--   그래서 세 칸을 같이 올림. 칸마다 "약 값일 때만" 바꿈 — 다른 값이 들어 있으면 그대로 둠
--   (AUTO인데 칸이 섞여 있는 행은 없지만, 있어도 사용자가 고른 듯한 값을 덮지 않음)
-- 이 마이그레이션은 값만 바꿈 — 칸 · 제약 · 함수는 그대로.
--   set_updated_at 트리거가 updated_at을 갱신하고, keep_keys 트리거는 열쇠 칸(user_id · participant_id · routine_id)만 봄.
--   폰의 예약은 앱이 다시 읽을 때 reconcile(lib/alarmSync)이 강도 비교로 다시 걸음 — 서버 쪽 추가 작업 없음.

update public.alarms
   set intensity  = 'NORMAL',
       voice_tone = case when voice_tone = 'CALM' then 'NEUTRAL'::public.voice_tone else voice_tone end,
       sound_key  = case when sound_key = 'theme_calm' then 'theme_default' else sound_key end
 where intensity_source = 'AUTO'
   and intensity = 'SOFT';
