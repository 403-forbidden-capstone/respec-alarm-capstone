import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Sheet, Text } from '@/components/ui';
import { useAction } from '@/lib/useAction';

import { cleanInviteCode } from '../draft';

type Props = {
  visible: boolean;
  onClose: () => void;
  onJoin: (code: string) => Promise<void>; // 정리한 코드(공백 없는 대문자). 틀린 코드는 UserError로 던지면 토스트로 보임. 성공 뒤 닫고 이동하는 것은 부른 쪽이 함
};

// 실데이터 초대 코드는 영문 대문자 · 숫자 6~12자 (DB groups_invite_code_format, 기본 8자), 가짜 모드는 CAP-6KQ3 모양
const CODE_MAX = 12;

// U07 코드로 참여 시트 — 코드를 넣고 [참여]. 입력하는 대로 공백을 빼고 대문자로 바꿈
// 시트 내용은 루트의 SheetHost에서 그려지고, 닫으면 지워져서 다시 열 때 입력칸이 비어 있음
export function JoinGroupSheet({ visible, onClose, onJoin }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="그룹 참여하기">
      <JoinForm onJoin={onJoin} />
    </Sheet>
  );
}

function JoinForm({ onJoin }: Pick<Props, 'onJoin'>) {
  const [code, setCode] = useState('');
  const { busy, run } = useAction();

  const join = () => run(() => onJoin(code), '그룹에 참여하지 못했어요');

  return (
    <View>
      <Card>
        <Field
          first
          label="초대 코드"
          value={code}
          onChangeText={(text) => setCode(cleanInviteCode(text))}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={CODE_MAX}
          placeholder="친구가 보낸 코드"
          returnKeyType="done"
          onSubmitEditing={code ? join : undefined}
        />
      </Card>
      <Text variant="caption" style={styles.help}>
        그룹을 만든 친구에게 초대 코드를 받아 넣어 주세요.
      </Text>
      <View style={styles.button}>
        <Button label="참여" loading={busy} disabled={!code} onPress={join} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { marginTop: 6, marginHorizontal: 4 },
  button: { marginTop: 16 },
});
