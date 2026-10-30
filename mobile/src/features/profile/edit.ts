// 설정에서 값을 고칠 때의 순수 판단 (시험: __tests__/edit.test.ts) — 편집 시트(components/ProfileEditors)가 [저장]을 켤지 정할 때 씀
import { cleanHandle, cleanNickname, isHandleFormat, isNicknameOk, shouldSaveHandle } from '@/features/onboarding/validate';
import type { PrepareValues } from '@/features/onboarding/views/PrepareStep';

import type { Place } from '@/features/alarm/types';

import type { Profile, ProfileFields } from './types';

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

// 집으로 고른 장소를 프로필 칸으로 — 좌표가 없는 장소(최근 장소 등)는 null.
// 서버가 출발지 '집'의 좌표를 프로필에서 채우므로 좌표 없이 이름만 바꾸면 새 일정 계산이 막힘 → 부르는 쪽이 거절함
export function homePatch(place: Pick<Place, 'name' | 'lat' | 'lng'>): ProfileFields | null {
  if (typeof place.lat !== 'number' || typeof place.lng !== 'number') return null;
  return { home_name: place.name, home_lat: place.lat, home_lng: place.lng };
}
