import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { Button, Card, Field, Screen, SectionHeader, Text, toast, Toggle, TopBar } from '@/components/ui';
import { createGroup, saveShareSettings } from '@/features/social/api';
import { Note } from '@/features/social/components/Note';
import { togglePermission } from '@/features/social/permissions';
import { PERMISSIONS, type CreatedGroup, type PermissionSet } from '@/features/social/types';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { colors } from '@/theme';

// 그룹 이름 최대 글자 수 — api.ts createGroup과 같은 값
const NAME_MAX = 50;

// 새 그룹에서 처음 켜 둘 공유 범위 — 알람 조회 · 기상 상태 조회만 켜고 알람 설정은 끈 채로
//   근거 없음 — 작성자 판단: 남이 내 알람을 바꾸는 권한은 직접 켜게 (D64 제안 4 참고)
const START: PermissionSet = { viewAlarm: true, editAlarm: false, viewWake: true };

type Created = CreatedGroup & { name: string };

// 새 그룹 만들기 — G01 그룹 탭 "새 그룹 만들기"에서 옴 (지형님 와이어프레임 4번 · 목업 번호 없음)
//   1단계: 이름 + 그룹원에게 보여 줄 것(F03과 같은 스위치) → 만들기
//   2단계: 초대 코드 보여 주기 → 코드 보내기 · 그룹으로 가기
export default function NewGroupScreen() {
  const [name, setName] = useState('');
  const [share, setShare] = useState<PermissionSet>(START);
  const [created, setCreated] = useState<Created | null>(null);
  const { busy, run } = useAction();
  const trimmed = name.trim();
  const { allowLeave } = useLeaveGuard(!created && trimmed.length > 0);

  const create = () =>
    run(async () => {
      const g = await createGroup(trimmed);
      // 그룹은 이미 만들어졌으므로 공유 범위 저장이 실패해도 코드 화면으로 넘어가고 안내만 함
      try {
        await saveShareSettings(`group:${g.id}`, share);
      } catch {
        toast('공유 범위는 저장하지 못했어요. 공유 권한 설정에서 다시 정해 주세요');
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
        {PERMISSIONS.map(({ key, name: label, description }, i) => (
          <View key={key} style={[styles.toggleRow, i > 0 && styles.divider]}>
            <View style={styles.grow}>
              <Text variant="bodyStrong">{label}</Text>
              <Text variant="small" tone="sub" style={styles.description}>
                {description}
              </Text>
            </View>
            <Toggle value={share[key]} onChange={(next) => setShare(togglePermission(share, key, next))} label={label} disabled={busy} />
          </View>
        ))}
      </Card>
      <Note>멤버별 최종 권한은 친구 관계와 참여 중인 모든 그룹의 허용 권한을 합쳐 정해져요. 나중에 공유 권한 설정에서 바꿀 수 있어요.</Note>
    </Screen>
  );
}

// 만든 뒤 — 초대 코드 보여 주기 (와이어프레임 "그룹을 만들었어요")
function InviteStep({ group: g }: { group: Created }) {
  // 코드를 다른 앱으로 보냄 (카카오톡 · 메시지 · 복사는 공유창에서). 웹처럼 공유창이 없으면 길게 눌러 복사하도록 안내 — G02 "+ 초대"와 같은 방식
  async function shareInvite() {
    try {
      await Share.share({ message: `Re:Spec 알람 '${g.name}' 그룹에 초대해요. 초대 코드: ${g.inviteCode}` });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      toast('코드를 길게 눌러 복사해 주세요');
    }
  }

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
        <Button label="코드 보내기" variant="ghost" onPress={shareInvite} />
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
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  description: { marginTop: 2 },
  center: { textAlign: 'center' },
  codeBox: { alignItems: 'center', marginVertical: 16 },
});
