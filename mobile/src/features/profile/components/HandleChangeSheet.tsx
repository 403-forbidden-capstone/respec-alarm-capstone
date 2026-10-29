import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Field, Sheet, Text } from '@/components/ui';
import { cleanHandle, HANDLE_RULE, isValidHandle } from '@/features/social/draft';
import { useAction } from '@/lib/useAction';

type Props = {
  visible: boolean;
  onClose: () => void;
  current: string | null; // 지금 아이디 (@ 없이). 아직 안 정했으면 null → "아이디 정하기"
  onSubmit: (handle: string) => Promise<void>; // 정리된 아이디(@ 없는 소문자). 실패는 UserError로 던지면 토스트로 보임. 성공 뒤 닫는 것은 부른 쪽이 함
  nextChangeAt?: string; // 다음에 바꿀 수 있는 날 (예: 11월 28일). 있으면 아직 못 바꾸는 중이라 저장을 막음
};

// 아이디 바꾸기 시트 — 설정 · 친구 탭 · 온보딩이 같이 씀. 입력 검사는 온보딩과 같은 규칙
// 시트 내용은 루트의 SheetHost에서 그려지고, 닫으면 지워져서 다시 열 때 입력칸이 비어 있음
export function HandleChangeSheet({ visible, onClose, current, onSubmit, nextChangeAt }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={current ? '아이디 바꾸기' : '아이디 정하기'}>
      <HandleForm current={current} onSubmit={onSubmit} nextChangeAt={nextChangeAt} />
    </Sheet>
  );
}

function HandleForm({ current, onSubmit, nextChangeAt }: Pick<Props, 'current' | 'onSubmit' | 'nextChangeAt'>) {
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  const clean = cleanHandle(text);
  const valid = isValidHandle(clean);
  const same = valid && clean === current;
  const canSave = valid && !same && !nextChangeAt;

  return (
    <View>
      <Card>
        <Field
          first
          label="아이디"
          value={text}
          onChangeText={setText}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={21}
          placeholder={current ?? 'respec_kim'}
          returnKeyType="done"
        />
      </Card>
      <Text variant="caption" tone={text && !valid ? 'warn' : 'faint'} style={styles.help}>
        {HANDLE_RULE}
      </Text>
      {same ? (
        <Text variant="caption" tone="warn" style={styles.help}>
          지금 쓰는 아이디예요.
        </Text>
      ) : null}
      <Text variant="caption" style={styles.help}>
        아이디는 30일에 한 번 바꿀 수 있어요
      </Text>
      {nextChangeAt ? (
        <Text variant="caption" tone="warn" style={styles.help}>
          {nextChangeAt}부터 다시 바꿀 수 있어요
        </Text>
      ) : null}
      <View style={styles.button}>
        <Button label="저장" loading={busy} disabled={!canSave} onPress={() => run(() => onSubmit(clean), '아이디를 바꾸지 못했어요')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { marginTop: 6, marginHorizontal: 4 },
  button: { marginTop: 16 },
});
