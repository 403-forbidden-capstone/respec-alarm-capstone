import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';

import type { ConsentItem } from '../consent';

type Props = {
  items: readonly ConsentItem[];
};

// 개인정보 안내 단계 (L02-7) — 항목마다 읽는 것 / 안 읽는 것 / 친구에게 보이는 것. 동의 저장은 부르는 화면이 함
export function ConsentStep({ items }: Props) {
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
});
