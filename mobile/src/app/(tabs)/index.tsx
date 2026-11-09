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
import { cancelSnooze, getDaySchedule, getEarlyWake, getMorningPlan, getNextAlarm, getSnooze, getWakeInProgress } from '@/features/alarm/api';
import { EarlyWakeCard } from '@/features/alarm/components/EarlyWakeCard';
import { ProposalCards } from '@/features/social/components/ProposalCards';
import { ReceivedWakePingLine } from '@/features/social/components/ReceivedWakePingLine';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { MorningCard } from '@/features/alarm/components/MorningCard';
import { ScheduleList } from '@/features/alarm/components/ScheduleList';
import { TextLink } from '@/features/alarm/components/TextLink';
import { useAppointmentToggle } from '@/features/alarm/hooks/useAppointmentToggle';
import { useDepartCheck } from '@/features/alarm/hooks/useDepartCheck';
import { useNow } from '@/features/alarm/hooks/useNow';
import { morningCardVisible } from '@/features/alarm/morning';
import { isEvening } from '@/features/alarm/schedule';
import { KIND_LABEL } from '@/features/alarm/types';
import { DetectionRows } from '@/features/location/DetectionRows';
import { bannerLines, bannerSummary, PermissionBanner, useFailedAlarmCount, usePermissions } from '@/features/permissions';
import { getPendingSuggestion } from '@/features/records/api';
import { advanceRoutine, getEveningRoutine, getTodayRoutine, listTodos, toggleTodo } from '@/features/routine/api';
import { RoutineCard } from '@/features/routine/components/RoutineCard';
import { TodoList } from '@/features/routine/components/TodoList';
import { getGroupSummary, listGroups } from '@/features/social/api';
import { wokeLine } from '@/features/social/wakeTexts';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { now } from '@/lib/clock';
import { addDays, dayKey, formatDate, formatMinuteOfDay, formatRelative, formatTime, minuteOfDay, startOfDay } from '@/lib/format';
import { canUseRealData } from '@/lib/mode';
import { openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { colors } from '@/theme';

const GROUP_ROWS = 3; // 홈에 보이는 그룹 줄 수 — 넘으면 "외 N개"

// 저녁(오후 6시부터 · 전날 밤)에는 내일 일정 · 내일 준비물, 낮에는 오늘 일정 · 오늘 루틴
// date = 그룹 기상 신호가 알려 준 날 (그룹 기상 요약만 씀, 없으면 오늘)
async function loadHome(date: string | null) {
  const today = startOfDay(now());
  const evening = isEvening(now());
  const target = evening ? addDays(today, 1) : today;
  const groups = await listGroups(date);
  const [next, schedule, routine, todos, suggestion, groupSummaries, eveningRoutine, snooze, wake, morning, early] = await Promise.all([
    getNextAlarm(),
    getDaySchedule(target),
    getTodayRoutine(),
    listTodos(target),
    getPendingSuggestion(),
    Promise.all(groups.map((g) => getGroupSummary(g.id, date))),
    evening ? getEveningRoutine() : Promise.resolve(null),
    getSnooze(),
    getWakeInProgress(),
    // 아침 카드 — 저녁에는 안 보이니 안 읽음. 덧붙임 줄이라 못 읽어도 홈 전체가 막히지 않게 없는 것으로 (진행 중 기상 확인 · 미룸과 같은 방침)
    evening ? Promise.resolve(null) : getMorningPlan().catch(() => null),
    // [먼저 깼어요] 입구 — 기상 알람 60분 전부터 (11/9 결정표). 덧붙임 카드라 못 읽어도 홈은 그대로
    getEarlyWake().catch(() => null),
  ]);
  const summaries = groupSummaries.flatMap((g) => (g ? [g] : []));
  return { evening, target, next, schedule, routine, todos, suggestion, groups: summaries, eveningRoutine, snooze, wake, morning, early };
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
  const toggleAppointment = useAppointmentToggle(reload); // 다음 알람 카드 스위치
  const { run } = useAction(); // 루틴 단계 · 준비물 체크는 한 번에 하나씩, 실패하면 토스트 (실데이터는 네트워크 오류가 있음)
  const permissions = usePermissions(); // 홈 빨간 줄 — 알림 · 전체화면 알림이 꺼짐, 폰에 못 건 알람
  const failedAlarms = useFailedAlarmCount();
  const depart = useDepartCheck(data?.morning?.appointmentId); // 아침 카드 [다시 확인]

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
  const { evening, target, next, schedule, routine, todos, suggestion, groups, eveningRoutine, snooze, wake, morning, early } = data;
  // 추가한 일정이 홈이 보여 주는 날(낮 = 오늘, 저녁 = 내일)에 들어가게 날짜를 넘김
  const newSchedule = () => router.push({ pathname: '/schedule/new', params: { from: 'home', date: dayKey(target) } });

  function tickRoutine() {
    if (!routine) return;
    void run(async () => {
      const updated = await advanceRoutine(routine.id);
      if (updated && updated.done === updated.steps.length) toast('오늘 루틴을 모두 마쳤어요');
      await reload();
    });
  }

  function tickTodo(id: string) {
    void run(async () => {
      await toggleTodo(id);
      await reload();
    });
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
    // 실데이터에서는 폰 예약을 못 지울 수 있어(네이티브 오류) run으로 — 두 번 누름 막기 · 실패 토스트
    await run(async () => {
      const { wakeCheck } = await cancelSnooze(snooze.alarmId);
      toast('미루기를 취소했어요');
      // 기상 알람의 미루기 취소는 해제로 기록됨(실데이터) — 알람을 끈 것과 같게 기상 확인으로 이어감
      if (wakeCheck) router.push({ pathname: '/wake', params: { alarm: snooze.alarmId } });
      await reload();
    }, '미루기를 취소하지 못했어요');
  }

  const shownGroups = groups.slice(0, GROUP_ROWS);
  const moreGroups = groups.length - shownGroups.length;
  const snoozed = snooze != null && snooze.at.getTime() > current.getTime();
  const permissionSummary = bannerSummary(bannerLines(permissions.snapshot, { failedCount: failedAlarms, hasAlarm: next != null }));

  return (
    <Screen onRefresh={reload}>
      <TopBar
        left={
          <Text variant="small" tone="sub">
            {formatDate(current)}
          </Text>
        }
        right={
          // D90 기본안 A — 홈 위 오른쪽 '알람 전체' 옆. 설정은 실데이터를 쓸 수 있을 때만 (아니면 _layout에서 settings가 빠져 막다른 길)
          <View style={styles.topActions}>
            <TopBarButton label="알람 전체" onPress={() => router.push('/alarms')} />
            {canUseRealData ? <TopBarButton label="설정" onPress={() => router.push('/settings')} /> : null}
          </View>
        }
      />
      <Text variant="title" style={styles.title}>
        {greeting(current)}
      </Text>

      {permissionSummary ? <PermissionBanner text={permissionSummary} onPress={() => router.push('/ring-check')} /> : null}
      {/* 아침 카드 자리 — 인사 바로 아래. 다른 줄(알림 · 제안 등)은 이 위에 끼워 넣음 */}
      {morning && morningCardVisible(morning, current) ? (
        <MorningCard
          plan={morning}
          current={current}
          check={depart.check}
          busy={depart.busy}
          onRecheck={depart.recheck}
          onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: morning.appointmentId } })}
        />
      ) : null}
      {/* 위치로 잡은 출발 · 도착 — 출발하면 아침 카드가 빠지고 이 줄이 그 자리를 이음 */}
      <DetectionRows reloadOn={data} onChanged={reload} />

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

      {/* 친구가 보낸 알람 시각 제안 (친구 10장) */}
      <ProposalCards onChanged={() => void reload()} />

      <SectionHeader title="다음 알람" right={next ? formatRelative(current, next.alarm.at) : undefined} />
      {next ? (
        <AppointmentAlarmCard appointment={next.appointment} current={current} onToggle={(on) => toggleAppointment(next.appointment, on)} />
      ) : (
        <EmptyState
          title="예정된 알람이 없어요"
          body="일정을 추가하면 기상 · 준비 · 출발 알람을 계산해 드려요."
          action={{ label: '새 일정', onPress: newSchedule }}
        />
      )}

      {/* 기상 알람 60분 전부터 [먼저 깼어요] — 누르면 카드가 사라지고 그룹 줄의 내 상태가 '일어났어요'로 */}
      {early ? (
        <EarlyWakeCard
          early={early}
          onDone={() => {
            toast('일어났어요로 기록했어요');
            void reload();
          }}
        />
      ) : null}

      {/* 오늘 친구가 깨운 기록 한 줄 (친구 8장) */}
      <ReceivedWakePingLine />

      <SectionHeader title={evening ? '내일 일정' : '오늘 일정'} right={
          <View style={styles.links}>
            <TextLink label="학교 시간표" onPress={() => router.push('/timetable')} />
            <TextLink label="+ 새 일정" onPress={newSchedule} strong />
          </View>
        } />
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

      {/* 제안 카드 — 점선은 목업 · 피그마 그대로, 누르면 제안 상세(S01)로 가니 '보기 ›' 꼬리 */}
      {suggestion ? (
        <Card variant="dash" onPress={() => router.push({ pathname: '/suggestion/[id]', params: { id: suggestion.id } })}>
          <View style={styles.banner}>
            <View style={styles.bannerText}>
              <Text variant="bodyLarge" weight={600}>
                {suggestion.title}
              </Text>
              <Text variant="small" tone="sub" style={styles.cardSub}>
                {suggestion.summary}
              </Text>
            </View>
            <Text variant="rowLabel" tone="sub">
              보기 ›
            </Text>
          </View>
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
              accessibilityLabel={[group.name, wokeLine(group.wokeCount)].filter(Boolean).join(', ')}
              style={({ pressed }) => [styles.group, i > 0 && styles.groupDivider, pressed && styles.pressed]}
            >
              <View style={styles.avatars}>
                {group.members.map(({ person, state }, j) => (
                  <View key={person.id} style={[styles.avatarRing, j > 0 && styles.avatarOverlap]}>
                    <Avatar initial={person.initial} small dot={state.dot ?? undefined} />
                  </View>
                ))}
              </View>
              <View style={styles.bannerText}>
                <Text variant="bodyStrong">{group.name}</Text>
                {/* 그 그룹 약속이 없는 날은 그 줄을 숨김 (7-사) */}
                {group.wokeCount != null ? (
                  <Text variant="small" tone="sub">
                    {wokeLine(group.wokeCount)}
                  </Text>
                ) : null}
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
  links: { flexDirection: 'row', gap: 14 },
  title: { marginTop: 8, marginBottom: 4 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
