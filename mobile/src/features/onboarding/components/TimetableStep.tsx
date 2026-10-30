import { StyleSheet, View } from 'react-native';

import { Button, Card, DayPicker, EmptyState, Field, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { toggleWeekday } from '@/features/alarm/repeat';
import { now } from '@/lib/clock';
import { addMinutes, formatTime, startOfDay } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';
import { colors } from '@/theme';

import { PickRow } from './PickRow';

export type ClassRow = {
  id: string;
  name: string;
  days: Weekday[];
  startMinutes: number | null; // 0시부터 분. 아직 안 골랐으면 null
  place: string; // 장소 이름. 아직 안 골랐으면 ''
  result?: 'ok' | 'error'; // 저장해 본 결과 (줄마다)
  resultNote?: string; // 'error'일 때 이유
  existing?: 'skip' | 'include'; // 이미 저장한 수업과 같음 — skip = 기본으로 저장에서 뺌, include = 사용자가 "그래도 넣기"
};

type Props = {
  rows: ClassRow[];
  onChangeRow: (id: string, patch: Partial<ClassRow>) => void;
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onPickPlace: (id: string) => void; // 장소 찾기 시트는 부르는 화면이 엶
  onPickTime: (id: string) => void; // 시각 고르는 시트도 부르는 화면이 엶
  onToggleExisting?: (id: string) => void; // 이미 있는 수업 줄의 "그래도 넣기" · "빼기"
  saving?: boolean; // 저장하는 동안 입력을 막음
};

// 0시부터 분 → 오전 9:00 (lib/format 모양)
const timeLabel = (minutes: number) => formatTime(addMinutes(startOfDay(now()), minutes));

// 수업 시간표 단계 내용(직접 입력) — 줄마다 과목 · 요일 · 시작 시각 · 장소. 저장은 틀의 주된 버튼이 부르는 화면에서 함
export function TimetableStep({ rows, onChangeRow, onAddRow, onRemoveRow, onPickPlace, onPickTime, onToggleExisting, saving }: Props) {
  return (
    <View pointerEvents={saving ? 'none' : 'auto'} style={saving && styles.saving}>
      {rows.length === 0 ? (
        <EmptyState
          title="아직 수업이 없어요"
          body="수업을 넣으면 수업 전 알람을 자동으로 맞춰요"
          action={{ label: '수업 추가', onPress: onAddRow }}
        />
      ) : (
        <>
          {rows.map((row) => (
            <Card key={row.id} style={row.existing === 'skip' && styles.skipped}>
              {row.existing && onToggleExisting ? (
                <View style={styles.existing}>
                  <Text variant="small" tone="warn" style={styles.existingText}>
                    {row.existing === 'skip' ? '이미 있는 수업이에요 · 저장하지 않아요' : '이미 있는 수업이지만 넣어요'}
                  </Text>
                  <TextLink label={row.existing === 'skip' ? '그래도 넣기' : '빼기'} onPress={() => onToggleExisting(row.id)} accessibilityLabel={`${row.name || '이'} 수업 ${row.existing === 'skip' ? '그래도 넣기' : '빼기'}`} />
                </View>
              ) : null}
              <Field
                first
                label="과목"
                value={row.name}
                onChangeText={(name) => onChangeRow(row.id, { name })}
                maxLength={40}
                placeholder="예: 자료구조"
              />
              <View style={styles.days}>
                <Text variant="rowLabel" tone="sub" style={styles.daysLabel}>
                  요일
                </Text>
                <DayPicker value={row.days} onToggle={(day) => onChangeRow(row.id, { days: toggleWeekday(row.days, day) })} />
              </View>
              <PickRow
                label="시작 시각"
                value={row.startMinutes == null ? null : timeLabel(row.startMinutes)}
                placeholder="시각 고르기"
                onPress={() => onPickTime(row.id)}
              />
              <PickRow label="장소" value={row.place || null} placeholder="장소 고르기" onPress={() => onPickPlace(row.id)} />
              <View style={styles.foot}>
                <View style={styles.result} accessibilityLiveRegion="polite">
                  {row.result === 'ok' ? (
                    <Text variant="caption" tone="sub">
                      저장됐어요
                    </Text>
                  ) : null}
                  {row.result === 'error' ? (
                    <Text variant="caption" tone="warn">
                      {row.resultNote ?? '저장하지 못했어요'}
                    </Text>
                  ) : null}
                </View>
                <TextLink label="줄 지우기" onPress={() => onRemoveRow(row.id)} accessibilityLabel={`${row.name || '이'} 수업 줄 지우기`} />
              </View>
            </Card>
          ))}
          <Button variant="ghost" label="+ 수업 추가" onPress={onAddRow} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  saving: { opacity: 0.6 },
  skipped: { opacity: 0.55 },
  existing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 10 },
  existingText: { flex: 1 },
  days: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line },
  daysLabel: { marginBottom: 8 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 12,
  },
  result: { flex: 1 },
});
