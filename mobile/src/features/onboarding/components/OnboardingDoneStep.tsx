import { StyleSheet, View } from 'react-native';

import { Card, KeyValueRow, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

type Props = {
  summary?: { label: string; value: string }[]; // 지금까지 정한 것. 비면 안 그림
};

// 끝 단계 내용 — 주된 버튼 [첫 일정 만들기] · 글자 버튼 [나중에]는 틀(OnboardingFrame)이 맡음
export function OnboardingDoneStep({ summary = [] }: Props) {
  return (
    <View>
      <Text variant="body">{keepWords('이제 첫 일정을 만들면 알람이 맞춰져요')}</Text>
      {summary.length > 0 ? (
        <Card style={styles.card}>
          {summary.map((item, i) => (
            <KeyValueRow key={item.label} first={i === 0} label={item.label} value={item.value} />
          ))}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16 },
});
