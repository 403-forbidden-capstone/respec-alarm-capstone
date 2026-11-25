import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius, space } from '@/theme';

// 기상 공유 안내 단계 (L02-9) — 안내만, 저장 없음
// D94 기본안 A — 그룹에 들어갈 때 기상 공유를 물어보고, 사람별로 숨길 수 있음
// 글 두 줄 대신 홈 흐름 카드의 사람 줄(얼굴 겹침 + 그룹 · 준비 중 · 기상 완료)을 예시 그림으로 보여 줌
const FACES = ['민', '준', '서'];

export function ShareStep() {
  return (
    <View style={styles.card} accessible accessibilityLabel="예시: 그룹에 들어가면 홈에서 친구들의 준비 중 · 기상 완료 상태가 보여요">
      <Text variant="small" tone="sub">
        홈에서는 이렇게 보여요
      </Text>
      <View style={styles.together}>
        <View style={styles.faces}>
          {FACES.map((n, i) => (
            <View key={n} style={[styles.face, i > 0 && styles.faceNext]}>
              <Text variant="caption" tone="ink" weight={600}>
                {n}
              </Text>
            </View>
          ))}
        </View>
        <Text variant="caption" tone="sub" numberOfLines={1} style={styles.line}>
          캡스톤팀 · 준비 중 1 · 기상 완료 2
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.card, paddingHorizontal: space.cardX, paddingVertical: space.cardY, gap: 12 },
  together: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  faces: { flexDirection: 'row' },
  face: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  faceNext: { marginLeft: -6 },
  line: { flex: 1 },
});
