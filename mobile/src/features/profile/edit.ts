// 설정에서 값을 고칠 때의 순수 판단 (시험: __tests__/edit.test.ts) — 편집 시트(components/ProfileEditors)가 [저장]을 켤지 정할 때 씀
import { cleanHandle, cleanNickname, isHandleFormat, isNicknameOk, shouldSaveHandle } from '@/features/onboarding/validate';
import type { PrepareValues } from '@/features/onboarding/views/PrepareStep';

import type { Profile } from './types';

// 프로필의 아침 준비 값 — 편집기의 처음 값. 범위는 편집기(Stepper)와 같게 맞춤
export function prepareValuesOf(profile: Pick<Profile, 'default_prepare_minutes' | 'default_buffer_minutes' | 'default_transport' | 'wake_margin'>): PrepareValues {
  return {
    prepare: Math.min(300, Math.max(5, profile.default_prepare_minutes)),
    buffer: Math.min(60, Math.max(0, profile.default_buffer_minutes)),
    transport: profile.default_transport,
    margin: profile.wake_margin,
  };
}

// 닉네임을 저장할 수 있는지 — 규칙에 맞고 지금 값과 다를 때
export function canSaveNickname(initial: string, draft: string): boolean {
  return isNicknameOk(draft) && cleanNickname(draft) !== initial;
}

// 아이디를 저장할 수 있는지 — 형식에 맞고 지금 아이디와 다를 때 (중복 확인은 저장할 때)
export function canSaveHandle(initial: string | null, draft: string): boolean {
  return isHandleFormat(draft) && shouldSaveHandle(cleanHandle(draft), initial);
}

export function isPrepareChanged(initial: PrepareValues, draft: PrepareValues): boolean {
  return (
    initial.prepare !== draft.prepare || initial.buffer !== draft.buffer || initial.transport !== draft.transport || initial.margin !== draft.margin
  );
}
