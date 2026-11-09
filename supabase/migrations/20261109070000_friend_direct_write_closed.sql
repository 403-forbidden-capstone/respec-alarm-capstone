-- =====================================================================
-- 친구 표를 앱이 직접 고치는 길 닫기 — 수락 · 거절 · 끊기는 함수로만 (친구 논리설계 15장 '함수 밖 우회 차단'의 남은 부분). 헤드 결정 11/9
--   요청 직접 insert는 15장(#434)에서 닫았고, 같은 표의 직접 update(수락) · delete(거절 · 취소 · 끊기) 정책이 남아 있었음.
--   남은 문제: 친구 100명인 사람에게 온 요청을 앱이 `update friends set status = 'ACCEPTED'`로 직접 수락하면 accept_friend_request의 100명 상한(FRIEND_LIMIT)을
--   안 거쳐 101명이 됨(검수가 확인). 직접 delete도 사람별 잠금 · 공유 권한 정리 · 대기 요청 정리를 안 거침
--   앱은 friends를 읽기만 하고 쓰기는 전부 함수(send_friend_request · accept_friend_request · decline_friend_request · cancel_friend_request · remove_friend · block_user)라 앱 영향 없음
-- =====================================================================

-- 정책이 없으면 RLS가 앱 역할의 update · delete를 오류 없이 0행으로 만듦(안 보이는 행과 같은 모양).
--   함수는 모두 security definer라 이 정책을 안 거치고, 서버 역할(service_role)과 DB 예약(요청 30일 만료 배치)도 RLS를 안 거침
--   표 안의 상태 규칙 트리거(guard_friend_status: 대기 → 친구로만, 수락 시각은 서버가)는 그대로 — 서버 쪽 잘못된 고침을 막는 마지막 방어
drop policy friends_update_addressee on public.friends;
drop policy friends_delete_party on public.friends;
