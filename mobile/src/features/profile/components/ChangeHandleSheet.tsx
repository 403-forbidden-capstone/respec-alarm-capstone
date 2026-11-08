import { Sheet, toast } from '@/components/ui';

import { useChangeHandle } from '../hooks/useChangeHandle';
import { HandleEditor } from './ProfileEditors';

// 아이디 바꾸기 시트 — 설정 [아이디] 줄과 친구 탭 [내 아이디 바꾸기]가 같이 씀 (친구 2장)
//   저장은 훅(useChangeHandle)이 함 — 서버가 형식 · respec_ · 예약어 · 중복 · 30일 1번 · 횟수를 판정하고, 못 바꾼 이유는 입력칸 아래에 보임
export function ChangeHandleSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { profile, hint, save } = useChangeHandle();
  if (!profile || !hint) return null;

  async function onSave(handle: string): Promise<string | null> {
    const { message, note } = await save(handle);
    if (message) return message;
    onClose();
    toast(note);
    return null;
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="아이디">
      <HandleEditor initial={profile.handle} hint={hint} onSave={onSave} onCancel={onClose} />
    </Sheet>
  );
}
