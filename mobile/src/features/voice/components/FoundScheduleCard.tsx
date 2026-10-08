import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { formatDateParen, formatTime } from '@/lib/format';
import { colors } from '@/theme';

import type { FoundSchedule } from '../types';
import { Bubble, BubbleTime } from './ChatBubble';

type Props = {
  found: FoundSchedule;
  at: Date; // 카드를 띄운 시각
  onSave: () => void;
  onEdit: () => void; // 새 일정(H05)에서 고쳐서 저장
  onReject: () => void;
  disabled?: boolean; // 저장 · 저장 안 함이 도는 중
};

// 대화에서 찾은 일정 카드 (.xcard) — 저장 · 수정 · 저장 안 함, 고른 뒤에는 결과만
export function FoundScheduleCard({ found, at, onSave, onEdit, onReject, disabled }: Props) {
  return (
    <Bubble who="ai" wide>
      <Text variant="caption" tone="faint" style={styles.head}>
        대화에서 찾은 내용
      </Text>
      <Row label="일정" value={found.title} />
      <Row label="날짜 · 시간" value={`${formatDateParen(found.at)} ${formatTime(found.at)}`} />
      <Row label="장소" value={found.place} />
      {found.items.length ? <Row label="준비물" value={found.items.join(', ')} note="바로 추가함" /> : null}
      <Text variant="bodyStrong" style={styles.question}>
        “{found.question}”
      </Text>
      {found.status === 'PENDING' ? (
        <View style={styles.buttons}>
          <Button label="저장" small onPress={onSave} disabled={disabled} />
          <Button label="수정" small variant="ghost" onPress={onEdit} disabled={disabled} />
          <Button label="저장 안 함" small variant="plain" onPress={onReject} disabled={disabled} />
        </View>
      ) : (
        <Text variant="small" tone="sub" style={styles.result}>
          {found.status === 'APPLIED' ? '저장했어요' : '저장하지 않았어요'}
        </Text>
      )}
      <BubbleTime who="ai" at={at} />
    </Bubble>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.row}>
      <Text variant="note" tone="sub">
        {label}
      </Text>
      <Text variant="note" weight={600} align="right" style={styles.value}>
        {value}
        {note ? (
          <Text variant="caption" tone="sub">
            {' '}
            {note}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { marginBottom: 6 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  value: { flexShrink: 1 },
  question: { marginVertical: 10 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  result: { marginTop: 6 },
});
