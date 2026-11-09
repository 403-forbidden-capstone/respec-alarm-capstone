-- =====================================================================
-- 친구가 알람을 바로 고치는 옛 길 닫기 (친구 논리설계 10장 · D9 '주인에게 푸시만' · 10-마 '주인이 [적용]해야 바뀜'). 이슈 #427
--   PR #415(10장)는 propose_alarm_time · respond_alarm_proposal을 만들면서도 이 길(alarms_update_shared)은 일부러 열어 뒀음 —
--   앱 G04가 그 길로 시각 · 켬/끔을 고치고 있어서 닫으면 앱이 깨졌기 때문. 앱 G04가 제안 보내기로 옮겨진 뒤(PR #423, 11/9) 닫음
--   열려 있던 동안의 문제: 설정 권한(EDIT_ALARM)이 있는 친구가 PostgREST로 주인 몰래 알람 시각 · 켬/끔을 바꿀 수 있었고(±60분 한도도 안 걸림)
--   푸시도 안 갔음(can_send_push의 ALARM_CHANGED는 '방금 보낸 대기 중 제안'이 있어야 true)
-- =====================================================================

-- 정책 이름을 바꾸고 주인 전용으로 좁힘 — 알람 시각 · 켬/끔 · time_source 등은 주인 본인만 앱(PostgREST)으로 바꿈.
--   친구가 바꾸는 값은 제안 → 주인 [적용](respond_alarm_proposal, security definer)으로만 들어감. 서버 함수(service_role)는 RLS를 안 거침.
--   바뀌는 것은 '친구의 직접 update'뿐: 친구가 건 update는 using에서 걸려 0행(오류 아님, 안 보이는 행과 같은 모양)
--   (주인 · 연결 칼럼은 기존 alarms_keep_keys 트리거가 그대로 막음, 원래 시각 기억 가드도 그대로)
drop policy alarms_update_shared on public.alarms;

create policy alarms_update_own on public.alarms
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
