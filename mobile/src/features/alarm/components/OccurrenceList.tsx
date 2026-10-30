import { StyleSheet, View } from 'react-native';

import { Card, KeyValueRow, Text } from '@/components/ui';
import { formatDateShort, formatTime } from '@/lib/format';

import { visibleOccurrences } from '../schedule';
import type { Occurrence } from '../types';
import { TextLink } from './TextLink';

type Props = {
  occurrences: readonly Occurrence[]; // 지금 이후 회차, 시각 순 (listOccurrences)
  currentId: string; // 지금 열어 둔 회차 — "이 일정"으로 표시
  expanded: boolean; // 접힌 회차까지 펼쳤는지 — 상태는 화면이 들고 있음
  onToggleExpanded: () => void;
};

// 반복 일정의 앞으로 회차 (H03) — 다음 3회만 보이고 나머지는 "더 보기"로 접음. 회차 목록은 이 화면에서만 보임 (목록 · 홈에는 한 장)
export function OccurrenceList({ occurrences, currentId, expanded, onToggleExpanded }: Props) {
  const { shown, hidden } = visibleOccurrences(occurrences, expanded);
  return (
    <Card>
      <Text variant="label" tone="sub" style={styles.label}>
        앞으로 회차 · {occurrences.length}회
      </Text>
      {shown.map((x, i) => (
        <KeyValueRow
          key={x.id}
          first={i === 0}
          label={`${formatDateShort(x.at)}${x.id === currentId ? ' · 이 일정' : ''}`}
          value={formatTime(x.at)}
          sub={x.alarmAt ? `첫 알람 ${formatTime(x.alarmAt)}` : '켜진 알람 없음'}
        />
      ))}
      {hidden > 0 ? (
        <View style={styles.more}>
          <TextLink
            label={expanded ? '접기' : `더 보기 (${hidden}회)`}
            accessibilityLabel={expanded ? '앞으로 회차 접기' : `앞으로 회차 ${hidden}회 더 보기`}
            onPress={onToggleExpanded}
          />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: 8 },
  more: { alignSelf: 'flex-start', paddingTop: 8 },
});
