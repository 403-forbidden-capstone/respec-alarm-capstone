import { Sheet, toast } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { now } from '@/lib/clock';

import { changeMyHandle } from '../api';
import { handleChangeMessage, handleHint } from '../handle';
import { HandleEditor } from './ProfileEditors';

// 아이디 바꾸기 시트 — 설정 [아이디] 줄과 친구 탭 [내 아이디 바꾸기]가 같이 씀 (친구 2장)
//   저장은 change_my_handle(DB 함수)로만. 서버가 형식 · respec_ · 중복 · 30일 1번을 판정하고, 못 바꾼 이유는 입력칸 아래에 보임
//   바꾼 뒤엔 프로필을 다시 읽어 줄 · 안내가 새 값으로 바뀜 (다른 사람 화면은 다시 열 때 새 아이디)
export function ChangeHandleSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { profile, refreshProfile } = useAuth();
  if (!profile) return null;
  const hint = handleHint({ changedAt: profile.handle_changed_at, nextChangeAt: profile.handle_next_change_at }, now());

  async function save(handle: string): Promise<string | null> {
    const result = await changeMyHandle(handle);
    const message = handleChangeMessage(result);
    if (message) return message;
    let note = result.status === 'SAME' ? '그대로예요' : '바꿨어요';
    try {
      await refreshProfile();
    } catch {
      note = '바꿨어요 · 화면을 새로 불러오지 못했어요'; // 저장은 됐음 — 실패로 보이지 않게
    }
    onClose();
    toast(note);
    return null;
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="아이디">
      <HandleEditor initial={profile.handle} hint={hint} onSave={save} onCancel={onClose} />
    </Sheet>
  );
}
