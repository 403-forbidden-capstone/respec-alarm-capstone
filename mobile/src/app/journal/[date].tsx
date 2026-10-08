import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button, Card, Chip, Screen, Text, Timeline, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { declineRoutineSuggestion, editJournal, getJournal } from '@/features/routine/api';
import type { Journal } from '@/features/routine/types';
import { dateParts, formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors, typeScale } from '@/theme';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';

// A03 하루 기록 · 일기 — 기록된 사실만 골라 AI가 쓴 일기 · 오늘의 사실 · 회고 코칭 · 루틴 제안
// 일기는 AI 대화(A02)를 마치면 생기고, 다시 마치면 다시 씀(고친 글 · 루틴 제안 응답은 그대로). AI 대기라 목업 문장틀로 씀
export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const { data, reload } = useLoad(() => getJournal(date));
  const back = backOrHome; // 앞 화면이 없으면(주소로 바로 열기) 홈으로
  const top = <TopBar onBack={back} screenId="A03" />;

  if (data === undefined) return <Screen>{top}</Screen>;
  if (data === null) {
    return (
      <Screen>
        {top}
        <Text variant="title" style={styles.title}>
          하루 기록
        </Text>
        <Card>
          <Text variant="body" tone="sub">
            자기 전 AI 대화를 마치면 오늘 기록으로 일기를 만들어요.
          </Text>
          <View style={styles.stack}>
            {/* 탭 루트로 돌아가 AI 탭을 엶 — 일기 화면은 기록에서 빠짐 (목업 A.tab, wake의 dismissTo와 같은 방식) */}
            <Button label="AI 대화 하러 가기" onPress={() => router.dismissTo('/ai')} />
          </View>
        </Card>
      </Screen>
    );
  }
  return <JournalView journal={data} reload={reload} top={top} />;
}

function JournalView({ journal: j, reload, top }: { journal: Journal; reload: () => Promise<boolean>; top: ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null); // 고치는 중인 글 (null = 읽기)
  const { busy, run } = useAction(); // 저장 · 괜찮아요는 한 번에 하나씩, 실패하면 토스트
  const { month, day } = dateParts(j.date);

  const save = () =>
    run(async () => {
      if (editing == null) return;
      await editJournal(j.recordDate, editing);
      setEditing(null);
      toast('일기를 저장했어요');
      await reload();
    });

  const decline = () =>
    run(async () => {
      await declineRoutineSuggestion(j.recordDate);
      toast('알겠어요 · 14일 동안 같은 루틴은 제안하지 않아요');
      await reload();
    });

  return (
    <Screen>
      {top}
      <Text variant="title" style={styles.title}>
        {month}월 {day}일 하루 기록
      </Text>
      <Text variant="lead" style={styles.lead}>
        기록된 사실만 골라 AI가 쓴 일기예요.
      </Text>

      <Card>
        <View style={styles.between}>
          <Text variant="label" tone="sub">
            AI 일기
          </Text>
          <Chip label={j.edited ? '직접 수정함' : 'AI 작성'} variant="fill" />
        </View>
        {editing != null ? (
          <>
            <TextInput
              value={editing}
              onChangeText={setEditing}
              multiline
              textAlignVertical="top"
              accessibilityLabel="일기 수정"
              style={styles.input}
            />
            <View style={styles.row}>
              <Button label="저장" small onPress={save} disabled={!editing.trim() || busy} />
              <Button label="취소" small variant="ghost" onPress={() => setEditing(null)} />
            </View>
          </>
        ) : (
          <>
            <Text variant="reading" style={styles.text}>
              {j.text}
            </Text>
            <View style={styles.link}>
              <TextLink label="수정" onPress={() => setEditing(j.text)} />
            </View>
          </>
        )}
        <Text variant="caption" tone="faint" style={styles.note}>
          숫자와 시각은 기록과 대조해 확인했어요.
        </Text>
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          {'오늘의 사실 · 출처 우선순위 직접 입력 > 자동 > 알림 > AI'}
        </Text>
        {j.facts.length ? (
          <Timeline items={j.facts.map((f) => ({ time: formatTime(f.at), label: f.label, source: f.source }))} />
        ) : (
          <Text variant="body" tone="sub">
            기록된 사실이 없어요.
          </Text>
        )}
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          회고 코칭
        </Text>
        <Text variant="reading" style={styles.text}>
          {j.coaching}
        </Text>
        <Text variant="label" tone="sub" style={[styles.label, styles.gap]}>
          격려
        </Text>
        <Text variant="reading" style={styles.text}>
          {j.encouragement}
        </Text>
      </Card>

      {j.suggestion.status === 'PENDING' ? (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            루틴 제안 · {j.suggestion.reason}
          </Text>
          <Text variant="big">{j.suggestion.title}</Text>
          <Text variant="small" tone="sub">
            {j.suggestion.summary}
          </Text>
          <View style={styles.row}>
            <Button
              label="루틴 만들기"
              small
              onPress={() => router.push({ pathname: '/routine/[id]', params: { id: 'new', journal: j.recordDate } })}
            />
            <Button label="괜찮아요" small variant="ghost" onPress={decline} disabled={busy} />
          </View>
        </Card>
      ) : (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            루틴 제안
          </Text>
          <Text variant="small" tone="sub">
            {j.suggestion.status === 'APPLIED'
              ? `${j.suggestion.title} 루틴을 만들었어요.`
              : '이 루틴은 14일 동안 다시 제안하지 않아요.'}
          </Text>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  gap: { marginTop: 10 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  text: { marginTop: 4, marginBottom: 6 },
  link: { alignSelf: 'flex-start' },
  note: { marginTop: 10 },
  input: {
    ...typeScale.reading,
    minHeight: 160,
    marginTop: 4,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    color: colors.ink,
  },
  row: { flexDirection: 'row', gap: 8, marginTop: 12 },
  stack: { gap: 10, marginTop: 16 },
});
