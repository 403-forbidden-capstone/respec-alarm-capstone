import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, LoadError, Screen, SectionHeader, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { getDaySchedule, getNextAlarm } from '@/features/alarm/api';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { ScheduleList } from '@/features/alarm/components/ScheduleList';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getPendingSuggestion } from '@/features/records/api';
import { advanceRoutine, getTodayRoutine, listTodos, toggleTodo } from '@/features/routine/api';
import { RoutineCard } from '@/features/routine/components/RoutineCard';
import { TodoList } from '@/features/routine/components/TodoList';
import { getGroupSummary, listGroups } from '@/features/social/api';
import { now } from '@/lib/clock';
import { addDays, formatDate, formatRelative, minuteOfDay, startOfDay } from '@/lib/format';
import { openGroupDetail } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// 저녁(오후 6시부터 · 전날 밤)에는 내일 일정 · 내일 준비물, 낮에는 오늘 일정 · 오늘 루틴
async function loadHome() {
  const t = now();
  const today = startOfDay(t);
  const evening = minuteOfDay(t) >= 18 * 60;
  const target = evening ? addDays(today, 1) : today;
  const groups = await listGroups();
  const [next, schedule, routine, todos, suggestion, group] = await Promise.all([
    getNextAlarm(),
    getDaySchedule(target),
    getTodayRoutine(),
    listTodos(target),
    getPendingSuggestion(),
    groups[0] ? getGroupSummary(groups[0].id) : Promise.resolve(null),
  ]);
  return { t, evening, next, schedule, routine, todos, suggestion, group };
}

function greeting(t: Date) {
  const m = minuteOfDay(t);
  if (m >= 18 * 60) return '차분한 저녁이에요';
  return m < 12 * 60 ? '좋은 아침이에요' : '좋은 오후예요';
}

// H01 홈 — 다음 알람 · 오늘 일정 · 루틴(아침) 또는 준비물(저녁) · 제안 · 그룹 기상
export default function HomeScreen() {
  const { data, error, reload } = useLoad(loadHome);
  const newSchedule = () => router.push('/schedule/new');

  if (!data) return (
    <Screen>
      <TopBar />
      {error ? <LoadError onRetry={reload} /> : null}
    </Screen>
  );
  const { t, evening, next, schedule, routine, todos, suggestion, group } = data;

  async function tickRoutine() {
    if (!routine) return;
    const updated = await advanceRoutine(routine.id);
    if (updated && updated.done === updated.steps.length) toast('오늘 루틴을 모두 마쳤어요');
    reload();
  }

  async function tickTodo(id: string) {
    await toggleTodo(id);
    reload();
  }

  return (
    <Screen>
      <TopBar
        left={
          <Text variant="small" tone="sub">
            {formatDate(t)}
          </Text>
        }
        right={<TopBarButton label="알람 전체" onPress={() => router.push('/alarms')} />}
      />
      <Text variant="title" style={styles.title}>
        {greeting(t)}
      </Text>

      {next ? (
        <>
          <SectionHeader title="다음 알람" right={formatRelative(t, next.alarm.at)} />
          <AppointmentAlarmCard appointment={next.appointment} onChanged={reload} />
        </>
      ) : null}

      <SectionHeader title={evening ? '내일 일정' : '오늘 일정'} right={<TextLink label="+ 일정 추가" onPress={newSchedule} strong />} />
      <Card>
        <ScheduleList items={schedule} />
      </Card>

      {!evening && routine ? (
        <>
          <SectionHeader title="오늘 루틴" right={`${routine.done}/${routine.steps.length} 완료`} />
          <RoutineCard routine={routine} onPress={tickRoutine} />
        </>
      ) : null}

      {evening ? (
        <>
          <SectionHeader title="내일 준비물" right={`${todos.filter((x) => x.done).length}/${todos.length}`} />
          <Card>
            <TodoList todos={todos} onToggle={tickTodo} />
          </Card>
          <Card>
            <Text variant="bodyStrong">자기 전 AI 대화</Text>
            <Text variant="small" tone="sub" style={styles.ctaText}>
              오늘을 돌아보고 내일 일정과 준비물을 정리해요.
            </Text>
            <View style={styles.ctaButton}>
              <Button label="대화 시작" onPress={() => router.push('/ai')} />
            </View>
          </Card>
        </>
      ) : null}

      {suggestion ? (
        <Card variant="dash" onPress={() => router.push({ pathname: '/suggestion/[id]', params: { id: suggestion.id } })}>
          <Text variant="bodyLarge" weight={600}>
            {suggestion.title}
          </Text>
          <Text variant="small" tone="sub" style={styles.cardSub}>
            {suggestion.summary}
          </Text>
        </Card>
      ) : null}

      {!evening && group ? (
        <Card onPress={() => openGroupDetail(group.id, 'tab')}>
          <View style={styles.group}>
            <View style={styles.avatars}>
              {group.members.map(({ person, state }, i) => (
                <View key={person.id} style={[styles.avatarRing, i > 0 && styles.avatarOverlap]}>
                  <Avatar initial={person.initial} small dot={state.dot} />
                </View>
              ))}
            </View>
            <View>
              <Text variant="bodyStrong">{group.name}</Text>
              <Text variant="small" tone="sub">
                오늘 {group.wokeCount}명 기상 완료
              </Text>
            </View>
          </View>
        </Card>
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  ctaText: { marginTop: 4 },
  ctaButton: { marginTop: 12 },
  cardSub: { marginTop: 2 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatars: { flexDirection: 'row' },
  avatarRing: { borderRadius: 18, borderWidth: 2, borderColor: colors.card },
  avatarOverlap: { marginLeft: -8 },
});
