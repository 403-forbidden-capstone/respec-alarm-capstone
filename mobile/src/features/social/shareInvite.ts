// 초대 코드를 다른 앱으로 보냄 — G02 초대 시트 · 그룹 만들기 결과가 같이 씀
import { Share } from 'react-native';

import { toast } from '@/components/ui';

import { inviteMessage } from './draft';

// 웹처럼 공유창이 없으면 코드를 길게 눌러 복사하도록 안내 (사용자가 창을 닫은 것은 오류가 아님)
export async function shareInvite(groupName: string, inviteCode: string): Promise<void> {
  try {
    await Share.share({ message: inviteMessage(groupName, inviteCode) });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return;
    toast('코드를 길게 눌러 복사해 주세요');
  }
}
