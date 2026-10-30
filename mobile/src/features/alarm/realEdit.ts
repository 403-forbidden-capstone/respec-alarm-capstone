// ① 일정 수정 · 삭제 — 실데이터 자리 (이슈 #211, D41 A). 서버 함수 `appointment-edit`은 4b에서 붙임
//   지금은 화면(L5 편집 시트)이 실서버에서 이 함수들을 부르면 토스트로 안내만 나가게 UserError를 던짐. 가짜 모드는 api.ts
//   4b에서 채울 때 모양: 서버 응답(alarm-commit 모양)을 applyCommit으로 폰에 반영, 삭제는 앱이 5초 안에는 서버로 안 보냄 (되돌리기 = 안 보냄)
import { UserError } from '@/lib/errors';

import type { AppointmentPatch, EditScope, UpdateOptions, UpdateResult } from './types';

const NOT_READY = '아직 실서버에서는 쓸 수 없어요';

export async function updateAppointment(_id: string, _patch: AppointmentPatch, _scope: EditScope, _options?: UpdateOptions): Promise<UpdateResult> {
  throw new UserError(NOT_READY);
}

export async function deleteAppointment(_id: string, _scope: EditScope): Promise<void> {
  throw new UserError(NOT_READY);
}

export async function restoreAppointment(_id: string): Promise<void> {
  throw new UserError(NOT_READY);
}

export async function leaveSharedAppointment(_id: string): Promise<void> {
  throw new UserError(NOT_READY);
}
