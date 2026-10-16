import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  confirm,
  EmptyState,
  Loading,
  LoadError,
  Screen,
  SectionHeader,
  Text,
  toast,
  TopBar,
  TopBarButton,
} from '@/components/ui';
import { cancelSnooze, getDaySchedule, getNextAlarm, getSnooze, getWakeInProgress } from '@/features/alarm/api';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { ScheduleList } from '@/features/alarm/components/ScheduleList';
import { TextLink } from '@/features/alarm/components/TextLink';
import { useNow } from '@/features/alarm/hooks/useNow';
import { isEvening } from '@/features/alarm/schedule';
import { KIND_LABEL } from '@/features/alarm/types';
import { getPendingSuggestion } from '@/features/records/api';
import { advanceRoutine, getEveningRoutine, getTodayRoutine, listTodos, toggleTodo } from '@/features/routine/api';
import { RoutineCard } from '@/features/routine/components/RoutineCard';
import { TodoList } from '@/features/routine/components/TodoList';
import { getGroupSummary, listGroups } from '@/features/social/api';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { now } from '@/lib/clock';
import { addDays, dayKey, formatDate, formatMinuteOfDay, formatRelative, formatTime, minuteOfDay, startOfDay } from '@/lib/format';
import { openGroupDetail } from '@/lib/nav';
import { colors } from '@/theme';

const GROUP_ROWS = 3; // 홈에 보이는 그룹 줄 수 — 넘으면 "외 N개"

// 저녁(오후 6시부터 · 전날 밤)에는 내일 일정 · 내일 준비물, 낮에는 오늘 일정 · 오늘 루틴
// date = 그룹 기상 신호가 알려 준 날 (그룹 기상 요약만 씀, 없으면 오늘)
async function loadHome(date: string | null) {
  const today = startOfDay(now());
  const evening = isEvening(now());
  const target = evening ? addDays(today, 1) : today;
  const groups = await listGroups(date);
  const [next, schedule, routine, todos, suggestion, groupSummaries, eveningRoutine, snooze, wake] = await Promise.all([
    getNextAlarm(),
    getDaySchedule(target),
    getTodayRoutine(),
    listTodos(target),
    getPendingSuggestion(),
    Promise.all(groups.map((g) => getGroupSummary(g.id, date))),
    evening ? getEveningRoutine() : Promise.resolve(null),
    getSnooze(),
    getWakeInProgress(),
  ]);
  const summaries = groupSummaries.flatMap((g) => (g ? [g] : []));
  return { evening, target, next, schedule, routine, todos, suggestion, groups: summaries, eveningRoutine, snooze, wake };
}

function greeting(t: Date) {
  const m = minuteOfDay(t);
  if (isEvening(t)) return '차분한 저녁이에요';
  return m < 12 * 60 ? '좋은 아침이에요' : '좋은 오후예요';
}

// H01 홈 — 다음 알람 · 오늘 일정 · 루틴 · 준비물 · 제안 · 그룹 기상
export default function HomeScreen() {
  const { data, error, reload } = useWakeLoad(loadHome, (d) => d.groups.map((g) => g.id)); // 그룹 기상 신호가 오면 다시 읽음
  const current = useNow(); // 30초마다 다시 읽음 — "N분 뒤" · 인사말이 열 때 값에 멈춰 있지 않게

  // 저녁으로 넘어갔거나 다음 알람 시각이 지났으면 내용을 다시 읽음
  const stale = data != null && (isEvening(current) !== data.evening || (data.next != null && data.next.alarm.at.getTime() < current.getTime()));
  useEffect(() => {
    if (stale) void reload();
  }, [stale, reload]);

  if (!data) return (
    <Screen>
      <TopBar />
      {error ? <LoadError onRetry={reload} /> : <Loading text="홈을 불러오는 중" />}
    </Screen>
  );
  const { evening, target, next, schedule, routine, todos, suggestion, groups, eveningRoutine, snooze, wake } = data;
  // 추가한 일정이 홈이 보여 주는 날(낮 = 오늘, 저녁 = 내일)에 들어가게 날짜를 넘김
  const newSchedule = () => router.push({ pathname: '/schedule/new', params: { from: 'home', date: dayKey(target) } });

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

  async function askCancelSnooze() {
    if (!snooze) return;
    const ok = await confirm({
      title: '미루기를 취소할까요?',
      message: `${formatTime(snooze.at)}에 다시 울리지 않아요. 직접 일어나야 해요.`,
      okLabel: '미루기 취소',
      cancelLabel: '그대로 두기',
      destructive: true,
    });
    if (!ok) return;
    await cancelSnooze(snooze.alarmId);
    toast('미루기를 취소했어요');
    reload();
  }

  const shownGroups = groups.slice(0, GROUP_ROWS);
  const moreGroups = groups.length - shownGroups.length;
  const snoozed = snooze != null && snooze.at.getTime() > current.getTime();

  return (
    <Screen onRefresh={reload}>
      <TopBar
        left={
          <Text variant="small" tone="sub">
            {formatDate(current)}
          </Text>
        }
        right={<TopBarButton label="알람 전체" onPress={() => router.push('/alarms')} />}
      />
      <Text variant="title" style={styles.title}>
        {greeting(current)}
      </Text>

      {/* 기상 알람을 끈 뒤 판정 중이면 H08로 다시 들어가는 길 */}
      {wake ? (
        <Card onPress={() => router.push({ pathname: '/wake', params: { alarm: wake.alarmId } })} accessibilityLabel="기상 확인 중, 보기">
          <View style={styles.banner}>
            <View style={styles.bannerText}>
              <Text variant="bodyStrong">기상 확인 중</Text>
              <Text variant="small" tone="sub">
                {wake.appointmentTitle} · 알람을 끈 뒤 폰 사용을 보고 있어요
              </Text>
            </View>
            <Text variant="rowLabel" weight={700}>
              보기
            </Text>
          </View>
        </Card>
      ) : null}

      {/* 미룬 알람은 다시 울리기 전까지 보이고 취소할 수 있음 */}
      {snooze && snoozed ? (
        <Card>
          <View style={styles.banner}>
            <View style={styles.bannerText}>
              <Text variant="bodyStrong">미룸 · {formatTime(snooze.at)}에 다시 울려요</Text>
              <Text variant="small" tone="sub">
                {KIND_LABEL[snooze.kind]} 알람 · {snooze.appointmentTitle}
              </Text>
            </View>
            <TextLink label="취소" onPress={askCancelSnooze} accessibilityLabel={`${snooze.appointmentTitle} 미루기 취소`} strong />
          </View>
        </Card>
      ) : null}

      <SectionHeader title="다음 알람" right={next ? formatRelative(current, next.alarm.at) : undefined} />
      {next ? (
        <AppointmentAlarmCard appointment={next.appointment} current={current} onChanged={reload} />
      ) : (
        <EmptyState
          title="예정된 알람이 없어요"
          body="일정을 추가하면 기상 · 준비 · 출발 알람을 계산해 드려요."
          action={{ label: '일정 추가', onPress: newSchedule }}
        />
      )}

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

      {/* 준비물은 낮에도 보임 — 낮에는 챙길 것이 있을 때만, 저녁에는 비어도 안내 */}
      {evening || todos.length ? (
        <>
          <SectionHeader title={evening ? '내일 준비물' : '오늘 준비물'} right={`${todos.filter((x) => x.done).length}/${todos.length}`} />
          <Card>
            <TodoList todos={todos} onToggle={tickTodo} />
          </Card>
        </>
      ) : null}

      {evening ? (
        <>
          {/* 저장한 저녁 루틴이 있으면 루틴 편집(A04)으로 — 목업 SCR.home 저녁 루틴 카드 */}
          {eveningRoutine ? (
            <>
              <SectionHeader title="저녁 루틴" />
              <Card
                onPress={() => router.push({ pathname: '/routine/[id]', params: { id: eveningRoutine.id } })}
                accessibilityLabel={`${eveningRoutine.title} 루틴 열기`}
              >
                <Text variant="bodyLarge" weight={600}>
                  {eveningRoutine.title}
                </Text>
                <Text variant="small" tone="sub" style={styles.cardSub}>
                  매주 {eveningRoutine.days.join(' · ')} · {formatMinuteOfDay(eveningRoutine.startMinute)}부터 {eveningRoutine.stepCount}단계
                </Text>
              </Card>
            </>
          ) : null}
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

      {/* 참여 중인 그룹 전부 (많으면 앞의 몇 개 + 외 N개) */}
      {!evening && shownGroups.length ? (
        <Card>
          {shownGroups.map((group, i) => (
            <Pressable
              key={group.id}
              onPress={() => openGroupDetail(group.id, 'tab')}
              accessibilityRole="button"
              accessibilityLabel={`${group.name}, 오늘 ${group.wokeCount}명 기상 완료`}
              style={({ pressed }) => [styles.group, i > 0 && styles.groupDivider, pressed && styles.pressed]}
            >
              <View style={styles.avatars}>
                {group.members.map(({ person, state }, j) => (
                  <View key={person.id} style={[styles.avatarRing, j > 0 && styles.avatarOverlap]}>
                    <Avatar initial={person.initial} small dot={state.dot} />
                  </View>
                ))}
              </View>
              <View style={styles.bannerText}>
                <Text variant="bodyStrong">{group.name}</Text>
                <Text variant="small" tone="sub">
                  오늘 {group.wokeCount}명 기상 완료
                </Text>
              </View>
            </Pressable>
          ))}
          {moreGroups > 0 ? (
            <View style={styles.moreGroups}>
              <TextLink
                label={`외 ${moreGroups}개 그룹 보기`}
                onPress={() => router.navigate({ pathname: '/group', params: { seg: 'group', open: String(Date.now()) } })}
              />
            </View>
          ) : null}
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
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  bannerText: { flex: 1 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingVertical: 6 },
  groupDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.7 },
  moreGroups: { alignSelf: 'flex-start', paddingTop: 8 },
  avatars: { flexDirection: 'row' },
  avatarRing: { borderRadius: 18, borderWidth: 2, borderColor: colors.card },
  avatarOverlap: { marginLeft: -8 },
});
