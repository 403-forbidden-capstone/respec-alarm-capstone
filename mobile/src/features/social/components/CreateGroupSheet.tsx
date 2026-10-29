import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Sheet, Text } from '@/components/ui';
import { useAction } from '@/lib/useAction';

import { shareInvite } from '../shareInvite';
import type { CreatedGroup } from '../types';
import { InviteCodeBox } from './InviteCodeBox';

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<CreatedGroup>; // 앞뒤 공백을 뗀 이름. 이름이 맞지 않으면 UserError로 던짐 (토스트로 보임)
  onOpenGroup: (groupId: string) => void; // [그룹 보기] — 시트를 닫고 그룹 상세로 가는 것은 부른 쪽이 함
};

const NAME_MAX = 50;

// U06 그룹 만들기 시트 — 이름을 넣고 만들면 같은 시트에서 초대 코드를 크게 보여 줌
// 시트 내용은 루트의 SheetHost에서 그려지고, 닫으면 지워져서 다시 열 때 처음부터 시작
export function CreateGroupSheet({ visible, onClose, onCreate, onOpenGroup }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="새 그룹 만들기">
      <CreateForm onCreate={onCreate} onOpenGroup={onOpenGroup} />
    </Sheet>
  );
}

function CreateForm({ onCreate, onOpenGroup }: Pick<Props, 'onCreate' | 'onOpenGroup'>) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<(CreatedGroup & { name: string }) | null>(null);
  const { busy, run } = useAction();
  const trimmed = name.trim();

  const create = () =>
    run(async () => {
      setCreated({ ...(await onCreate(trimmed)), name: trimmed });
    }, '그룹을 만들지 못했어요');

  if (created) {
    return (
      <View>
        <Text variant="small" tone="sub">
          이 코드를 친구에게 보내면 {created.name}에 참여할 수 있어요.
        </Text>
        <InviteCodeBox code={created.inviteCode} />
        <View style={styles.buttons}>
          <Button label="초대 보내기" onPress={() => shareInvite(created.name, created.inviteCode)} />
          <Button variant="ghost" label="그룹 보기" onPress={() => onOpenGroup(created.id)} />
        </View>
      </View>
    );
  }
  return (
    <View>
      <Card>
        <Field
          first
          label="그룹 이름"
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX}
          placeholder="예: 캡스톤팀"
          returnKeyType="done"
          onSubmitEditing={trimmed ? create : undefined}
        />
      </Card>
      <Text variant="caption" style={styles.help}>
        최대 {NAME_MAX}자예요. 만든 뒤 초대 코드를 친구에게 보내요.
      </Text>
      <View style={styles.buttons}>
        <Button label="만들기" loading={busy} disabled={!trimmed} onPress={create} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { marginTop: 6, marginHorizontal: 4 },
  buttons: { gap: 10, marginTop: 10 },
});
