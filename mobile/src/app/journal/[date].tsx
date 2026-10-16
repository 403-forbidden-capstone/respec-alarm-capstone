import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button, Card, Chip, confirm, LoadError, Loading, Screen, Text, Timeline, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { parseDayParam } from '@/features/alarm/schedule';
import { recordToday } from '@/features/records/api';
import { declineRoutineSuggestion, editJournal, getJournal } from '@/features/routine/api';
import type { Journal } from '@/features/routine/types';
import { dateParts, formatTime, isSameDay } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { useLoad } from '@/lib/useLoad';
import { colors, typeScale } from '@/theme';

// A03 하루 기록 · 일기 — 기록된 사실만 골라 AI가 쓴 일기 · 그날의 사실 · 회고 코칭 · 루틴 제안
// 일기는 AI 대화(A02)를 마치면 생기고, 다시 마치면 다시 씀(고친 글 · 루틴 제안 응답은 그대로). AI 대기라 목업 문장틀로 씀
// 날짜는 주소(/journal/2025-05-21)로 받음 — 기록(R02) 일간에서 그날 일기를 열 때 (D48)
export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const { data, error, reload } = useLoad(() => getJournal(date));
  const top = <TopBar onBack={backOrHome} screenId="A03" />; // 앞 화면이 없으면(주소로 바로 열기) 홈으로

  if (data === undefined) {
    return (
      <Screen>
        {top}
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) return <EmptyJournal date={date} top={top} />;
  return <JournalView journal={data} reload={reload} top={top} />;
}

// 일기가 없는 날 — 오늘은 AI 대화를 마치면 생기니 거기로 가는 길, 지난 날은 이유만 (그날 대화는 이미 지나감)
function EmptyJournal({ date, top }: { date: string | undefined; top: ReactNode }) {
  const day = parseDayParam(date);
  const today = recordToday();
  const parts = day && dateParts(day);

  return (
    <Screen>
      {top}
      <Text variant="title" style={styles.title}>
        {parts ? `${parts.month}월 ${parts.day}일 하루 기록` : '하루 기록'}
      </Text>
      <Card>
        {day && isSameDay(day, today) ? (
          <>
            <Text variant="body" tone="sub">
              자기 전 AI 대화를 마치면 오늘 기록으로 일기를 만들어요.
            </Text>
            <View style={styles.stack}>
              {/* 탭 루트로 돌아가 AI 탭을 엶 — 일기 화면은 기록에서 빠짐 (목업 A.tab, wake의 dismissTo와 같은 방식) */}
              <Button label="AI 대화 하러 가기" onPress={() => router.dismissTo('/ai')} />
            </View>
          </>
        ) : (
          <>
            <Text variant="body" tone="sub">
              {!day ? '날짜를 알 수 없어요.' : day.getTime() > today.getTime() ? '아직 오지 않은 날이에요.' : '이 날은 일기가 없어요.'}
            </Text>
            {day && day.getTime() < today.getTime() ? (
              <Text variant="small" tone="sub" style={styles.gap}>
                일기는 그날 자기 전에 AI 대화를 마치면 만들어져요.
              </Text>
            ) : null}
          </>
        )}
      </Card>
    </Screen>
  );
}

function JournalView({ journal: j, reload, top }: { journal: Journal; reload: () => Promise<boolean>; top: ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null); // 고치는 중인 글 (null = 읽기)
  const { busy, run } = useAction(); // 저장 · 괜찮아요는 한 번에 하나씩, 실패하면 토스트
  const { month, day } = dateParts(j.date);
  useLeaveGuard(editing != null && editing !== j.text); // 고친 글이 저장된 글과 다를 때만 나갈 때 물음
  const created = j.suggestion.status === 'APPLIED' ? j.routineId : null; // 만든 루틴
  const isToday = isSameDay(j.date, recordToday());

  const save = () =>
    run(async () => {
      if (editing == null) return;
      await editJournal(j.recordDate, editing);
      setEditing(null);
      toast('일기를 저장했어요');
      await reload();
    }, '일기를 저장하지 못했어요');

  // 14일 동안 같은 제안이 사라지므로 한 번 물어봄
  async function decline() {
    if (!(await confirm({ title: '이 제안을 14일 동안 숨길까요?', message: '14일 동안은 같은 루틴을 다시 제안하지 않아요.', okLabel: '숨기기' }))) return;
    await run(async () => {
      await declineRoutineSuggestion(j.recordDate);
      toast('알겠어요 · 14일 동안 같은 루틴은 제안하지 않아요');
      await reload();
    }, '제안을 넘기지 못했어요');
  }

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
        {/* 대조는 AI가 쓴 글에만 한 것 — 직접 고친 글에는 말하지 않음 */}
        {j.edited || editing != null ? null : (
          <Text variant="caption" tone="faint" style={styles.note}>
            숫자와 시각은 기록과 대조해 확인했어요.
          </Text>
        )}
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          {isToday ? '오늘' : '그날'}의 사실
        </Text>
        {j.facts.length ? (
          <>
            <Timeline items={j.facts.map((f) => ({ time: formatTime(f.at), label: f.label, source: f.source }))} />
            <Text variant="caption" tone="faint" style={styles.note}>
              같은 사실이 여러 곳에 남아 있으면 직접 입력 &gt; 자동 &gt; 알림 &gt; AI 순서로 믿어요.
            </Text>
          </>
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

      {/* 제안 글이 없는 일기(실데이터에서 AI가 루틴을 제안하지 않은 날)는 제안 카드를 접음 — 제목이 빈 글자 */}
      {j.suggestion.title === '' ? null : j.suggestion.status === 'PENDING' ? (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            루틴 제안{j.suggestion.reason ? ` · ${j.suggestion.reason}` : ''}
          </Text>
          <Text variant="big">{j.suggestion.title}</Text>
          {j.suggestion.summary ? (
            <Text variant="small" tone="sub">
              {j.suggestion.summary}
            </Text>
          ) : null}
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
          {created ? (
            <View style={[styles.link, styles.gap]}>
              <TextLink label="루틴 열기 ›" onPress={() => router.push({ pathname: '/routine/[id]', params: { id: created } })} />
            </View>
          ) : null}
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
