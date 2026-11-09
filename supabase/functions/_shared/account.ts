// 계정 삭제의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (account.test.ts). 연결은 account-delete/index.ts
//   본인만: 요청에 사용자 id를 받지 않고(보내면 로그인한 사람 것과 같아야 함, 다르면 403) 로그인한 사람의 계정만 지움
//   순서: ① DB 함수 prepare_account_delete(개인 약속 삭제 · 모든 그룹 나가기 · 푸시 토큰 삭제) ② 계정(auth.admin.deleteUser) 삭제 — 프로필 · 친구 · 권한 · 차단 · 알람 · 기록은 계정이 지워질 때 연쇄로 지워지고
//        공동 약속은 만든 사람 칸만 비어 남음 (친구 12장, supabase/README.md)
//   중간에 실패하면 다시 부르면 이어서 끝남(① 은 몇 번 불러도 같고, ② 는 이미 없는 계정이면 끝난 것으로 봄). 삭제 직후 같은 토큰은 로그인 확인(requireUser)에서 거절됨
import { dbFail } from './db.ts';
import { HttpError } from './errors.ts';
import { Reader, readJson } from './read.ts';

// 계정 삭제에 필요한 만큼만의 클라이언트 모양 (SupabaseClient가 그대로 맞고, 시험은 가짜로)
export type AccountService = {
  rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  auth: { admin: { deleteUser: (id: string) => Promise<{ error: { message: string; status?: number; code?: string } | null }> } };
};

export type AccountDeleteResult = { deleted: true; groups_left: number; groups_deleted: number; group_appointments_kept: number };

// 요청 읽기: 비어 있거나 {}이면 본인. userId를 같이 보내면 로그인한 사람 것이어야 함
export function readAccountDeleteRequest(root: Reader, callerId: string): void {
  const userId = root.uuid('userId');
  root.finish();
  if (userId !== undefined && userId.toLowerCase() !== callerId.toLowerCase()) {
    throw new HttpError('FORBIDDEN', '내 계정만 삭제할 수 있어요');
  }
}

// 요청 본문 읽기: 본문이 아예 없거나 공백뿐이면 {}로 받음(앱은 본문 없이 부름), 있으면 JSON이어야 하고(아니면 400) readAccountDeleteRequest로 검사
export async function readAccountDeleteBody(req: Request, callerId: string): Promise<void> {
  const hasBody = (await req.clone().text()).trim().length > 0;
  readAccountDeleteRequest(Reader.root(hasBody ? await readJson(req) : {}), callerId);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export async function runAccountDelete(service: AccountService, userId: string): Promise<AccountDeleteResult> {
  const prepared = await service.rpc('prepare_account_delete', { p_user_id: userId });
  if (prepared.error) dbFail('prepare_account_delete', prepared.error);
  const p = prepared.data as { groups_left?: unknown; groups_deleted?: unknown; group_appointments_kept?: unknown } | null;
  if (!p || !isInt(p.groups_left) || !isInt(p.groups_deleted) || !isInt(p.group_appointments_kept)) {
    // 준비가 됐는지 확실하지 않으면 계정을 지우지 않음
    console.error('[account-delete] prepare_account_delete 응답이 약속과 다름', JSON.stringify(prepared.data));
    throw new HttpError('INTERNAL', '데이터를 처리하지 못했어요. 잠시 후 다시 시도해 주세요');
  }

  const removed = await service.auth.admin.deleteUser(userId);
  if (removed.error) {
    const gone = removed.error.status === 404 || removed.error.code === 'user_not_found';
    if (!gone) {
      console.error('[account-delete] 계정 삭제 실패', removed.error.message);
      throw new HttpError('INTERNAL', '계정을 지우지 못했어요. 잠시 후 다시 시도해 주세요');
    }
  }
  return { deleted: true, groups_left: p.groups_left, groups_deleted: p.groups_deleted, group_appointments_kept: p.group_appointments_kept };
}
