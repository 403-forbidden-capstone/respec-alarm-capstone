// 계정 삭제 (친구 12장) — 서버가 하는 일: prepare_account_delete(모든 그룹 나가기 · 개인 약속 · 알람 · 기록 지우기 · 푸시 토큰 지우기) → auth 계정 삭제.
//   앱은 요약을 읽어 확인 두 번을 받고 account-delete 서버 함수를 한 번 부름. 중간에 실패하면 다시 불러서 이어서 끝냄(서버가 몇 번 불러도 같은 결과)
//   가짜 모드는 지울 계정이 없어 호출하지 않음 (설정이 실데이터 + 로그인일 때만 버튼을 보임)
import { callEdge, EdgeError } from '@/lib/edge';
import { supabase } from '@/lib/supabase';

import type { DeleteResult, DeleteSummary } from './types';

type SummaryRow = { groups_leaving?: number; groups_disappearing?: number; group_appointments_staying?: number; friends?: number };

// 서버 함수 타입(types/database.ts)은 서버 PR이 머지되고 타입을 다시 만들 때 들어오므로 그때까지 이름으로 부름
const rpc = supabase.rpc.bind(supabase) as unknown as (name: string) => Promise<{ data: unknown; error: Error | null }>;

export async function getDeleteSummary(): Promise<DeleteSummary> {
  const { data, error } = await rpc('my_account_delete_summary');
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | null | undefined;
  // 서버는 항상 한 줄을 줌 — 줄이 없으면 영향이 0으로 읽혀 '되돌릴 수 없어요' 한 줄만 보이므로 실패로 처리 (확인할 내용을 못 불러왔다고 안내)
  if (!row || typeof row !== 'object') throw new Error('my_account_delete_summary: 요약 줄이 없어요');
  return {
    groupsLeaving: row.groups_leaving ?? 0,
    groupsDisappearing: row.groups_disappearing ?? 0,
    groupAppointmentsStaying: row.group_appointments_staying ?? 0,
    friends: row.friends ?? 0,
  };
}

// 삭제 직후 같은 토큰은 서버가 거절함 — 성공하면 로그인 정보는 곧 쓸 수 없음(부르는 쪽이 이 기기 정리 · 로그아웃)
export async function deleteMyAccount(): Promise<DeleteResult> {
  const res = await callEdge<{ deleted?: boolean; groups_left?: number; groups_deleted?: number; group_appointments_kept?: number }>('account-delete', {}, { timeoutMs: 30_000 });
  if (res?.deleted !== true) throw new Error('account-delete: 삭제가 끝났다는 응답이 아니에요');
  return { groupsLeft: res.groups_left ?? 0, groupsDeleted: res.groups_deleted ?? 0, groupAppointmentsKept: res.group_appointments_kept ?? 0 };
}

// 삭제를 부른 뒤 서버가 로그인을 거절(AUTH_REQUIRED) — 서버가 이미 계정을 지웠는데 응답만 못 받았거나 로그인이 끝난 경우.
//   어느 쪽이든 이 기기에서 할 수 있는 일은 정리하고 로그인 화면으로 가는 것 (헤드 결정 11/9, 세션약속 '삭제 직후 같은 토큰은 거절')
export function isAccountGone(e: unknown): boolean {
  return e instanceof EdgeError && e.code === 'AUTH_REQUIRED';
}
