import { Share } from 'react-native';

import { toast } from '@/components/ui';

import { friendInviteMessage } from './inviteLink';

// 초대 코드를 다른 앱으로 보냄 (카카오톡 · 메시지 · 복사는 공유창에서)
// 웹처럼 공유창이 없으면 코드를 길게 눌러 복사하도록 안내 — 사용자가 창을 닫은 것(AbortError)은 오류가 아님
// G02 "+ 초대"(groups/[id]/index.tsx)에도 같은 코드가 있음 — 그 파일의 바로 위 줄을 #354가 고치고 있어, 머지 뒤 이 함수로 바꿈
export async function shareInvite(name: string, code: string) {
  try {
    await Share.share({ message: `Re:Spec 알람 '${name}' 그룹에 초대해요. 초대 코드: ${code}` });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return;
    toast('코드를 길게 눌러 복사해 주세요');
  }
}

// 친구 초대 문구(닉네임 + 아이디, 링크가 있으면 같이)를 다른 앱으로 보냄 — [카톡으로 초대]와 내 친구 링크 공유가 같이 씀
export async function shareFriendInvite(args: { nickname: string; handle?: string | null; url?: string }) {
  try {
    await Share.share({ message: friendInviteMessage(args) });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return;
    // 웹처럼 공유창이 없으면 문구를 복사해 둠
    try {
      await navigator.clipboard.writeText(friendInviteMessage(args));
      toast('초대 문구를 복사했어요. 붙여 넣어 보내 주세요');
    } catch {
      toast('공유하지 못했어요. 다시 해 주세요');
    }
  }
}
