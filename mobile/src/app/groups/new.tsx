import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button, Card, Field, Screen, Text, toast, TopBar } from '@/components/ui';
import { createGroup, setWakeShareOptIn } from '@/features/social/api';
import { ConsentSheet } from '@/features/social/components/ConsentSheet';
import { Note } from '@/features/social/components/Note';
import { expiresLabel, GROUP_NAME_MAX } from '@/features/social/groupTexts';
import { shareInvite } from '@/features/social/invite';
import type { CreatedGroup } from '@/features/social/types';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';

type Created = CreatedGroup & { name: string };

// 새 그룹 만들기 — G01 그룹 탭 "새 그룹 만들기"에서 옴 (친구 5장)
//   이름을 정하고 [만들기] → 바로 OS 공유창에 초대 글(코드 + 만료일) → 이어서 기상 공유 동의 시트([공유] [나중에]) → 그룹 상세
//   그룹장이 없어 만든 사람도 다른 멤버와 같은 메뉴를 씀. 알람 조회 · 설정은 멤버가 들어온 뒤 공유 권한 설정에서
export default function NewGroupScreen() {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const { busy, run } = useAction();
  const trimmed = name.trim();
  const { allowLeave } = useLeaveGuard(!created && trimmed.length > 0);

  const create = () =>
    run(async () => {
      if (created) return; // 동의 시트가 떠 있는 동안 키보드 완료로 또 만들지 않음
      const g = await createGroup(trimmed);
      allowLeave();
      // 만들자마자 보내기 — 공유창을 닫아도 그룹은 이미 만들어졌으니 동의 시트로 이어감
      await shareInvite(trimmed, g.inviteCode, g.expiresAt ? expiresLabel(g.expiresAt) : null);
      setCreated({ ...g, name: trimmed });
    }, '그룹을 만들지 못했어요. 다시 해 주세요');

  // 동의 시트 — [공유] = 기상 공유 켬. 그룹은 이미 만들어졌으므로 저장에 실패해도 그룹 상세로 가고 안내만 함 (5-06)
  const choose = (share: boolean) =>
    run(async () => {
      if (!created) return;
      if (share) {
        try {
          await setWakeShareOptIn(created.id, true);
        } catch {
          toast('기상 상태 공유는 켜지 못했어요. 그룹 상세에서 다시 해 주세요');
        }
      }
      openGroupDetail(created.id, 'stack');
    }, '그룹으로 가지 못했어요. 다시 해 주세요');

  return (
    <Screen footer={<Button label="만들기" onPress={create} disabled={!trimmed || created != null} loading={busy && created == null} />}>
      <ConsentSheet visible={created != null} groupName={created?.name} busy={busy} onChoose={choose} onClose={() => void choose(false)} />
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        새 그룹
      </Text>
      <Text variant="lead" style={styles.lead}>
        이름을 정하면 바로 친구에게 초대 코드를 보낼 수 있어요.
      </Text>

      <Card>
        <Field first label="그룹 이름" value={name} onChangeText={setName} maxLength={GROUP_NAME_MAX} placeholder="예: 아침 준비 메이트" returnKeyType="done" onSubmitEditing={create} />
      </Card>
      <Note>알람 조회 · 알람 설정은 구성원이 들어온 뒤 공유 권한 설정에서 정해요. 그룹장은 없고, 멤버 누구나 초대 · 이름 바꾸기를 할 수 있어요.</Note>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
});
