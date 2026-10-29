import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Sheet, Text } from '@/components/ui';
import { useAction } from '@/lib/useAction';

type Props = {
  visible: boolean;
  onClose: () => void; // [나중에] · 바깥 누름
  groupName: string;
  onConfirm: () => Promise<void>; // [공유하기] — 동의를 저장함. 실패는 UserError로 던지면 토스트로 보임. 성공 뒤 닫는 것은 부른 쪽이 함
};

// U08 기상 공유 동의 시트 — 이 그룹에 내 기상 상태를 보여 줄지. 무엇이 보이고 무엇이 안 보이는지를 세 줄로 알림
// D89 기본안 A: 그룹을 만든 직후 · 코드로 참여한 직후에도 같은 시트 (G02가 ?consent=1로 열릴 때)
export function WakeShareConsentSheet({ visible, onClose, groupName, onConfirm }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="기상 상태를 공유할까요?">
      <ConsentBody groupName={groupName} onClose={onClose} onConfirm={onConfirm} />
    </Sheet>
  );
}

function ConsentBody({ groupName, onClose, onConfirm }: Pick<Props, 'groupName' | 'onClose' | 'onConfirm'>) {
  const { busy, run } = useAction();
  return (
    <View>
      <Text variant="small" tone="sub">
        {groupName} 멤버에게 내 기상 상태를 보여 줄 수 있어요.
      </Text>
      <View style={styles.rows}>
        <Card>
          <KeyValueRow first label="보이는 것" value="일어났는지 · 아직인지" />
          <KeyValueRow label="안 보이는 것" value="준비 · 출발 · 도착" />
          <KeyValueRow label="언제" value="이 그룹 약속이 있는 날만" />
        </Card>
      </View>
      <View style={styles.buttons}>
        <Button label="공유하기" loading={busy} onPress={() => run(onConfirm, '공유 동의를 저장하지 못했어요')} />
        <Button variant="plain" label="나중에" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { marginTop: 12 },
  buttons: { gap: 4, marginTop: 4 },
});
