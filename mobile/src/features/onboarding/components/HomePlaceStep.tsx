import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { keepWords } from '@/lib/format';

import { PickRow } from './PickRow';

type Props = {
  homeName: string | null; // 고른 집 이름. 없으면 "집 찾기"
  onOpenSearch: () => void; // 장소 찾기 시트는 부르는 화면이 엶
  onClear?: () => void; // 있고 homeName이 있을 때만 "지우기"
};

// 집 위치 단계 내용 — "나중에"는 틀(OnboardingFrame)의 글자 버튼이 맡음
export function HomePlaceStep({ homeName, onOpenSearch, onClear }: Props) {
  return (
    <View>
      <Text variant="note" tone="sub">
        {keepWords('집 위치는 알람 계산과 출발 감지에 쓰고, 주소를 찾을 때 서버와 카카오에 전달돼요.')}
      </Text>
      <Card style={styles.card}>
        <PickRow first label="집 위치" value={homeName} placeholder="집 찾기" onPress={onOpenSearch} />
      </Card>
      {homeName && onClear ? (
        <View style={styles.clear}>
          <TextLink label="지우기" onPress={onClear} accessibilityLabel="집 위치 지우기" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16 },
  clear: { alignItems: 'flex-end', marginRight: 4 },
});
