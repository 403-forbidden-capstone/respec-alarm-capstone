import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';

type Props = {
  handle: string | null; // 내 아이디 (@ 없이). 아직 안 정했으면 null
  onChange: () => void; // 바꾸기 · 정하기
};

// 친구 탭 맨 위 "내 아이디" 줄 (U01) — 친구가 이 아이디로 나를 찾음
// 복사 버튼은 아직 없음 (expo-clipboard가 없어서) — 아이디를 길게 눌러 복사
export function MyHandleRow({ handle, onChange }: Props) {
  return (
    <Card>
      <View style={styles.row}>
        <View style={styles.grow}>
          {handle ? (
            <>
              <Text variant="label" tone="sub">
                내 아이디
              </Text>
              <Text variant="bodyStrong" selectable accessibilityLabel={`내 아이디 ${handle}`}>
                @{handle}
              </Text>
            </>
          ) : (
            <Text variant="body" tone="sub">
              아직 아이디가 없어요
            </Text>
          )}
        </View>
        <TextLink label={handle ? '바꾸기' : '정하기'} onPress={onChange} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
});
