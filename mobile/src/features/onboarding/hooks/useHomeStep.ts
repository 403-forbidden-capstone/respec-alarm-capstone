import { useState } from 'react';

import { toast } from '@/components/ui';
import type { Place } from '@/features/alarm/types';
import { saveProfileFields } from '@/features/profile/api';
import type { Profile, ProfileFields } from '@/features/profile/types';

import { homePatchOf } from '../home';

// 집 위치 단계(L02-4)의 상태 · 동작 — 부품(HomePlaceStep)과 장소 검색 시트에 값 · 콜백을 돌려줌
// 처음 값은 프로필의 집(이름 · 좌표가 다 있을 때만 — 좌표 없는 이름은 집으로 못 씀). 지우기는 화면 값만 비우고 저장된 값은 건드리지 않음
export function useHomeStep(profile: Profile | null, userId: string | null) {
  const [home, setHome] = useState<ProfileFields | null>(() =>
    profile?.home_name ? homePatchOf({ name: profile.home_name, lat: profile.home_lat ?? undefined, lng: profile.home_lng ?? undefined }) : null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [saved, setSaved] = useState(false); // 이 단계에서 집을 고르고 [다음]까지 지났음 (시간표 단계가 집 유무를 볼 때 씀)

  function pick(place: Place) {
    const patch = homePatchOf(place);
    if (!patch) {
      // 시트는 열어 둠 — 다른 장소를 바로 고르게
      toast('이 장소는 위치를 몰라 집으로 정할 수 없어요. 다른 장소를 골라 주세요');
      return;
    }
    setHome(patch);
    setSearchOpen(false);
  }

  return {
    homeName: home?.home_name ?? null,
    picked: home != null, // [다음]은 집을 골랐을 때만
    searchOpen,
    openSearch: () => setSearchOpen(true),
    closeSearch: () => setSearchOpen(false),
    pick,
    clear: () => setHome(null),
    // [다음] — 실데이터만 저장 (userId 없으면 저장 없이 통과). [나중에]는 이걸 부르지 않음
    saved,
    save: async () => {
      if (userId && home) await saveProfileFields(userId, home);
      if (home) setSaved(true);
    },
  };
}
