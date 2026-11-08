import { useAuth } from '@/features/auth/AuthProvider';
import { now } from '@/lib/clock';

import { changeMyHandle } from '../api';
import { handleChangeMessage, handleHint } from '../handle';

// 아이디 바꾸기 저장 — change_my_handle(DB 함수)로만. 부품(ChangeHandleSheet)은 api를 부르지 않고 이 훅이 함 (친구 2장)
//   save가 문구를 돌려주면 그게 저장하지 못한 이유(TAKEN · LIMIT · BUSY …), null이면 바뀜(또는 그대로) — 프로필을 다시 읽어 줄 · 안내가 새 값으로 바뀜
//   프로필을 다시 읽지 못해도 저장은 된 것이라 결과 문구만 달라짐 (note)
export function useChangeHandle() {
  const { profile, refreshProfile } = useAuth();
  const hint = profile ? handleHint({ changedAt: profile.handle_changed_at, nextChangeAt: profile.handle_next_change_at }, now()) : null;

  async function save(handle: string): Promise<{ message: string | null; note: string }> {
    const result = await changeMyHandle(handle);
    const message = handleChangeMessage(result);
    if (message) return { message, note: '' };
    let note = result.status === 'SAME' ? '그대로예요' : '바꿨어요';
    try {
      await refreshProfile();
    } catch {
      note = '바꿨어요 · 화면을 새로 불러오지 못했어요'; // 저장은 됐음 — 실패로 보이지 않게
    }
    return { message: null, note };
  }

  return { profile, hint, save };
}
