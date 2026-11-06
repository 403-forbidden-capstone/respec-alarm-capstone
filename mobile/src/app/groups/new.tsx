import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Screen, SectionHeader, Text, toast, Toggle, TopBar } from '@/components/ui';
import { createGroup, setWakeShareOptIn } from '@/features/social/api';
import { Note } from '@/features/social/components/Note';
import { shareInvite } from '@/features/social/invite';
import { PERMISSIONS, type CreatedGroup } from '@/features/social/types';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';

// 그룹 이름 최대 글자 수 — api.ts createGroup과 같은 값
const NAME_MAX = 50;

// 새 그룹에서 고르는 공유는 기상 상태 하나 — F03과 같은 이름 · 설명
//   기상 상태는 그룹 권한 행이 아니라 이 그룹에 대한 내 기상 공유 동의(wake_share_opt_in) 하나로 정해짐 (D19 A · D18 참고)
//   그래서 만든 사람 혼자인 그룹에서도 바로 효과가 남. 알람 조회 · 설정은 그룹 권한 행이라
//   새 구성원에게 행을 주는 D18이 반영되기 전에는 혼자인 그룹에 저장해도 아무것도 안 써짐 → 이 화면에서 빼고 안내만
const WAKE = PERMISSIONS.find((p) => p.key === 'viewWake')!;

type Created = CreatedGroup & { name: string };

// 새 그룹 만들기 — G01 그룹 탭 "새 그룹 만들기"에서 옴 (지형님 와이어프레임 4번 · 목업 번호 없음)
//   1단계: 이름 + 기상 상태 공유(F03과 같은 이름 · 설명) → 만들기
//   2단계: 초대 코드 보여 주기 → 코드 보내기 · 그룹으로 가기
export default function NewGroupScreen() {
  const [name, setName] = useState('');
  // 처음 켜 둠 — 근거 없음 — 작성자 판단 (기상 공유가 그룹의 주된 쓰임이라, 끄려면 직접 끔)
  const [shareWake, setShareWake] = useState(true);
  const [created, setCreated] = useState<Created | null>(null);
  const { busy, run } = useAction();
  const trimmed = name.trim();
  const { allowLeave } = useLeaveGuard(!created && trimmed.length > 0);

  const create = () =>
    run(async () => {
      const g = await createGroup(trimmed);
      // 기상 상태를 켰으면 이 그룹에 내 기상 공유 동의도 켬 (D19 A — 기상 조회를 켜면 동의도 같이 켬)
      // 그룹은 이미 만들어졌으므로 실패해도 코드 화면으로 넘어가고 안내만 함
      if (shareWake) {
        try {
          await setWakeShareOptIn(g.id, true);
        } catch {
          toast('기상 상태 공유는 켜지 못했어요');
        }
      }
      allowLeave();
      setCreated({ ...g, name: trimmed });
    }, '그룹을 만들지 못했어요');

  if (created) return <InviteStep group={created} />;

  return (
    <Screen footer={<Button label="만들기" onPress={create} disabled={!trimmed} loading={busy} />}>
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        새 그룹
      </Text>
      <Text variant="lead" style={styles.lead}>
        목적에 맞는 그룹을 만들고 공유 범위를 정해요.
      </Text>

      <Card>
        <Field
          first
          label="그룹 이름"
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX}
          placeholder="예: 아침 준비 메이트"
          returnKeyType="done"
        />
      </Card>

      <SectionHeader title="그룹원에게 보여 줄 것" />
      <Card>
        <View style={styles.toggleRow}>
          <View style={styles.grow}>
            <Text variant="bodyStrong">{WAKE.name}</Text>
            <Text variant="small" tone="sub" style={styles.description}>
              {WAKE.description}
            </Text>
          </View>
          <Toggle value={shareWake} onChange={setShareWake} label={WAKE.name} disabled={busy} />
        </View>
      </Card>
      <Note>알람 조회 · 알람 설정은 구성원이 들어온 뒤 공유 권한 설정에서 정해요.</Note>
    </Screen>
  );
}

// 만든 뒤 — 초대 코드 보여 주기 (와이어프레임 "그룹을 만들었어요")
function InviteStep({ group: g }: { group: Created }) {
  return (
    <Screen footer={<Button label="그룹으로 가기" onPress={() => openGroupDetail(g.id, 'stack')} />}>
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        그룹을 만들었어요
      </Text>
      <Text variant="lead" style={styles.lead}>
        친구에게 코드를 보내면 바로 들어올 수 있어요.
      </Text>

      <Card>
        <Text variant="label" tone="sub" style={styles.center}>
          {g.name} 초대 코드
        </Text>
        <View style={styles.codeBox}>
          <Text variant="stat" selectable accessibilityLabel={`초대 코드 ${g.inviteCode}`}>
            {g.inviteCode}
          </Text>
        </View>
        <Button label="코드 보내기" variant="ghost" onPress={() => shareInvite(g.name, g.inviteCode)} />
      </Card>
      <Note>{'카카오톡 · 메시지로 보내거나, 코드를 길게 눌러 복사할 수 있어요. 그룹 상세의 "+ 초대"에서도 다시 볼 수 있어요.'}</Note>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  grow: { flex: 1, minWidth: 0 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  description: { marginTop: 2 },
  center: { textAlign: 'center' },
  codeBox: { alignItems: 'center', marginVertical: 16 },
});
