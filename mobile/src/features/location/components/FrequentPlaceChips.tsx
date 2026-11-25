import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius, size } from '@/theme';

import type { UserPlace } from '../userPlaces';
import { useAccent } from '@/lib/skyTone';

type Props = {
  places: UserPlace[]; // 자주 가는 곳 (api.ts listUserPlaces). 비었으면 아무것도 그리지 않음
  onPick: (place: UserPlace) => void; // 칩을 누르면 그 곳 — 장소 칸을 채우는 것은 부르는 쪽
  selectedLabel?: string; // 지금 장소 칸이 이 이름표의 곳이면 칩을 켬
};

// 자주 가는 곳 칩 한 줄 — 학교 · 회사 · 알바. 새 일정 장소 줄(H05)과 온보딩 시간표 장소 기본값 위에 꽂아 쓰는 부품
// 값 · 콜백만 받음 (api.ts는 부르는 쪽이 부름)
// <FrequentPlaceChips places={places} onPick={(p) => setPlace({ name: p.name, lat: p.lat, lng: p.lng })} />
export function FrequentPlaceChips({ places, onPick, selectedLabel }: Props) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  if (!places.length) return null;
  return (
    <View style={styles.row}>
      {places.map((place) => {
        const on = place.label === selectedLabel;
        return (
          <Pressable
            key={place.label}
            onPress={() => onPick(place)}
            accessibilityRole="button"
            accessibilityLabel={`${place.label}로 정하기`}
            accessibilityState={{ selected: on }}
            hitSlop={{ top: 8, bottom: 8 }}
            style={({ pressed }) => [styles.chip, on && [styles.chipOn, { backgroundColor: accent }], pressed && styles.pressed]}
          >
            <Text variant="label" tone={on ? 'inverse' : 'ink'} numberOfLines={1}>
              {place.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    height: size.chip + 6,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pressed: { opacity: 0.6 },
});
