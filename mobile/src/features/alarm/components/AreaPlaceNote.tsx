import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';

import { TextLink } from './TextLink';

type Props = {
  onSearch: () => void; // [건물 검색] — 같은 이름으로 장소 검색 시트를 다시 엶 (부르는 쪽)
};

// 고른 장소가 캠퍼스 · 공원처럼 한 점을 대표 좌표로 쓰는 곳일 때 장소 줄 아래 경고 한 줄 (D68)
export function AreaPlaceNote({ onSearch }: Props) {
  return (
    <View style={styles.box}>
      <Text variant="note" tone="warn">
        캠퍼스 대표 위치예요. 건물을 고르면 도착이 정확해요
      </Text>
      <View style={styles.link}>
        <TextLink label="건물 검색" onPress={onSearch} strong />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingBottom: 12 },
  link: { alignSelf: 'flex-start', marginTop: 8 },
});
