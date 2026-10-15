import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Card } from './Card';
import { Text } from './Text';

type Props = {
  title: string; // 아직 일정이 없어요
  body?: string; // 한 줄 설명 (무엇을 하면 채워지는지)
  action?: { label: string; onPress: () => void }; // 바로 채우러 가는 버튼
};

// 목록이 비었을 때 (.empty) — 빈 칸 대신 이유 + 다음에 할 일. 못 읽었을 때는 LoadError
export function EmptyState({ title, body, action }: Props) {
  return (
    <Card variant="dash">
      <Text variant="bodyStrong">{title}</Text>
      {body ? (
        <Text variant="note" tone="sub" style={styles.body}>
          {body}
        </Text>
      ) : null}
      {action ? (
        <View style={styles.button}>
          <Button small variant="ghost" label={action.label} onPress={action.onPress} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: 4 },
  button: { marginTop: 12, alignSelf: 'flex-start' },
});
