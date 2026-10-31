// 개발 도구 — /dev/screens의 "내 시험 데이터 지우기"용. 개발 화면 전용이라 출시 빌드에서는 부르는 곳이 없음 (D16)
import { UserError } from '@/lib/errors';
import { isMock } from '@/lib/mode';
import { supabase } from '@/lib/supabase';

// 내 시험 데이터를 서버에서 지움 — 일정 · 알람 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안을 지우고 프로필을 온보딩 전으로 되돌림.
// 계정 · 친구 · 그룹은 그대로, 다른 사람이 참여 중인 공동 일정은 내 참여 행만 지움 (DB 함수 dev_reset_my_data, supabase/migrations/20261030220000_dev_reset_my_data.sql)
// 서버 쪽만 함 — 폰에 걸린 알람 · 메모리 정리는 부르는 화면이 lib/session의 cleanupAfterDataReset으로 이어서 함
export async function resetMyTestData(): Promise<void> {
  if (isMock()) throw new UserError('가짜 데이터 모드에서는 지울 게 없어요');
  const { error } = await supabase.rpc('dev_reset_my_data');
  if (error) throw error;
}
