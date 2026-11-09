import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors } from '@/theme';

import { AGE_CHECK_HINT, AGE_CHECK_LABEL, type ConsentItem } from '../consent';

type Props = {
  items: readonly ConsentItem[];
  ageChecked?: boolean; // 만 14세 이상 확인 — 없으면(이미 이 판에 동의한 계정) 체크 줄을 안 그림
  onAgeChange?: (next: boolean) => void;
};

// 개인정보 안내 단계 (L02-7) — 항목마다 읽는 것 / 안 읽는 것 / 친구에게 보이는 것. 동의 저장은 부르는 화면이 함
export function ConsentStep({ items, ageChecked, onAgeChange }: Props) {
  return (
    <>
      {items.map((item) => (
        <Card key={item.key}>
          <Text variant="bodyStrong">{item.title}</Text>
          <Line label="읽는 것" text={item.reads} />
          <Line label="안 읽는 것" text={item.doesNotRead} />
          <Line label="친구에게 보이는 것" text={item.friends} />
        </Card>
      ))}
      {onAgeChange ? (
        <Pressable
          onPress={() => onAgeChange(!ageChecked)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!ageChecked }}
          accessibilityLabel={AGE_CHECK_LABEL}
          style={styles.age}
        >
          <View style={[styles.box, ageChecked && styles.boxOn]}>{ageChecked ? <Text variant="small" style={styles.tick}>✓</Text> : null}</View>
          <View style={styles.ageText}>
            <Text variant="bodyStrong">{AGE_CHECK_LABEL}</Text>
            {!ageChecked ? (
              <Text variant="small" tone="sub">
                {AGE_CHECK_HINT}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ) : null}
    </>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.line}>
      <Text variant="small">{label}</Text>
      <Text variant="body">{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { marginTop: 10, gap: 2 },
  age: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.ink },
  tick: { color: colors.card },
  ageText: { flex: 1, minWidth: 0 },
});
