import { router } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import {
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
import { cancelSnooze, getAutoWake, getDaySchedule, getEarlyWake, getMorningPlan, getNextAlarm, getSnooze, getWakeInProgress } from '@/features/alarm/api';
import { AutoWakeCard } from '@/features/alarm/components/AutoWakeCard';
import { EarlyWakeCard } from '@/features/alarm/components/EarlyWakeCard';
import { ProposalCards } from '@/features/social/components/ProposalCards';
import { ReceivedWakePingLine } from '@/features/social/components/ReceivedWakePingLine';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { MorningCard } from '@/features/alarm/components/MorningCard';
import { TripCard } from '@/features/alarm/components/TripCard';
import { ScheduleList } from '@/features/alarm/components/ScheduleList';
import { TextLink } from '@/features/alarm/components/TextLink';
import { useAppointmentToggle } from '@/features/alarm/hooks/useAppointmentToggle';
import { useDepartCheck } from '@/features/alarm/hooks/useDepartCheck';
import { useNow } from '@/features/alarm/hooks/useNow';
import { useWakeCardRefresh } from '@/features/alarm/hooks/useWakeCardRefresh';
import { morningCardVisible, tripCardOf } from '@/features/alarm/morning';
import { isEvening } from '@/features/alarm/schedule';
import { KIND_LABEL } from '@/features/alarm/types';
import { DetectionRows } from '@/features/location/DetectionRows';
import { bannerLines, bannerSummary, PermissionBanner, useFailedAlarmCount, usePermissions } from '@/features/permissions';
import { RecordsSection, type Register } from '@/features/records/components/RecordsSection';
import { advanceRoutine, getEveningRoutine, getTodayRoutine, listTodos, toggleTodo } from '@/features/routine/api';
import { RoutineCard } from '@/features/routine/components/RoutineCard';
import { TodoList } from '@/features/routine/components/TodoList';
import { SkyBackdrop } from '@/features/sky/components/SkyBackdrop';
import { useSky } from '@/features/sky/hooks/useSky';
import { dayPartOfPhase, skyGreeting, type DayPart } from '@/features/sky/sky';
import { now } from '@/lib/clock';
import { addDays, dayKey, formatDate, formatMinuteOfDay, formatRelative, formatTime, minuteOfDay, startOfDay } from '@/lib/format';
import { canUseRealData, isMock } from '@/lib/mode';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// 저녁(오후 6시부터 · 전날 밤)에는 내일 일정 · 내일 준비물, 낮에는 오늘 일정 · 오늘 루틴
// 제안 카드 · 그룹 기상 카드는 그룹 탭으로 옮겨 홈에서는 안 읽음 (D110)
async function loadHome() {
  const today = startOfDay(now());
  const evening = isEvening(now());
  const target = evening ? addDays(today, 1) : today;
  const [next, schedule, routine, todos, eveningRoutine, snooze, wake, morning, early] = await Promise.all([
    getNextAlarm(),
    getDaySchedule(target),
    getTodayRoutine(),
    listTodos(target),
    evening ? getEveningRoutine() : Promise.resolve(null),
    getSnooze(),
    getWakeInProgress(),
    // 아침 카드 — 저녁에는 안 보이니 안 읽음. 덧붙임 줄이라 못 읽어도 홈 전체가 막히지 않게 없는 것으로 (진행 중 기상 확인 · 미룸과 같은 방침)
    evening ? Promise.resolve(null) : getMorningPlan().catch(() => null),
    // [먼저 깼어요] 입구 — 기상 알람 60분 전부터 (11/9 결정표). 덧붙임 카드라 못 읽어도 홈은 그대로
    getEarlyWake().catch(() => null),
  ]);
  // 자동 판정으로 확정한 기상 — 확정 뒤 60분 안 [아니에요] 카드 (D61 1탭 정정). 위 getWakeInProgress가 읽으면서 확정하므로 그 뒤에 읽음. 덧붙임 카드라 못 읽어도 홈은 그대로
  const autoWake = await getAutoWake().catch(() => null);
  return { evening, target, next, schedule, routine, todos, eveningRoutine, snooze, wake, morning, early, autoWake };
}

// 인사말의 때 — 저녁 화면이면 저녁, 아니면 정오 앞뒤로 아침 · 오후. 문구는 날씨와 합쳐 features/sky의 skyGreeting이 만듦
function dayPart(t: Date): DayPart {
  if (isEvening(t)) return 'evening';
  return minuteOfDay(t) < 12 * 60 ? 'morning' : 'afternoon';
}

// H01 홈 — 다음 알람 · 오늘 일정 · 루틴 · 준비물 · 맨 아래 나의 기록(R02 월간 · 주간 · 일간, D110)
export default function HomeScreen() {
  const { data, error, reload } = useLoad(loadHome);
  // 당겨서 새로고침 — 홈 내용 + 아래 기록 구역(보이는 월간 · 주간 · 일간)이 맡겨 둔 다시 읽기
  const recordsReload = useRef<(() => Promise<unknown>) | null>(null);
  const registerRecords = useCallback<Register>((r) => {
    recordsReload.current = r;
  }, []);
  const refresh = useCallback(() => Promise.all([reload(), recordsReload.current?.()]), [reload]);
  const current = useNow(); // 30초마다 다시 읽음 — "N분 뒤" · 인사말이 열 때 값에 멈춰 있지 않게
  const sky = useSky(); // 위쪽 하늘 배경 — 날씨 × 시간대
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

  // 기상 확인 중 카드가 있는 동안 15초마다 다시 읽음 — 판정은 읽을 때 확정되므로 안 읽으면 상세 화면에 들어가야 카드가 사라짐
  useWakeCardRefresh(data?.wake != null && !isMock(), reload); // 가짜 데이터는 시연 버튼으로 넘기므로 안 읽음 (H08과 같은 방침)

  if (!data) return (
    <Screen>
      <TopBar />
      {error ? <LoadError onRetry={reload} /> : <Loading text="홈을 불러오는 중" />}
    </Screen>
  );
  const { evening, target, next, schedule, routine, todos, eveningRoutine, snooze, wake, morning, early, autoWake } = data;
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

  const snoozed = snooze != null && snooze.at.getTime() > current.getTime();
  const permissionSummary = bannerSummary(bannerLines(permissions.snapshot, { failedCount: failedAlarms, hasAlarm: next != null }));

  return (
    <Screen onRefresh={refresh} backdrop={<SkyBackdrop kind={sky.kind} phase={sky.phase} />}>
      <TopBar
        left={
          // 하늘 배경 맨 위라 본문 색 — 보조 색은 대비가 모자람 (features/sky/sky.ts SKY_SUB_TEXT_FROM)
          <Text variant="small" tone="ink">
            {formatDate(current)}
          </Text>
        }
        // D90 기본안 A — 홈 위 오른쪽. '알람 전체'는 2번 탭이 되어 뺌 (D110). 설정은 실데이터를 쓸 수 있을 때만 (아니면 _layout에서 settings가 빠져 막다른 길)
        right={canUseRealData ? <TopBarButton label="설정" glass onPress={() => router.push('/settings')} /> : undefined}
      />
      <Text variant="title" style={styles.title}>
        {skyGreeting(sky.kind, sky.preview ? dayPartOfPhase(sky.phase) : dayPart(current))}
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
      {/* 출발한 뒤 — 아침 카드 자리에 '이동 중 · 도착 예정', 도착하면 '도착했어요' (약속 + 60분까지) */}
      {(() => {
        const trip = tripCardOf(morning, current);
        return trip && morning ? <TripCard view={trip} onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: morning.appointmentId } })} /> : null;
      })()}
      {/* 위치로 잡은 출발 · 도착 — 출발하면 아침 카드가 빠지고 이 줄이 그 자리를 이음 */}
      <DetectionRows reloadOn={data} onChanged={reload} />

      {/* 자동 판정으로 기상이 확정되면 그 자리에서 1탭 정정 — [아니에요]면 취소하고 H08 확인 단계로 (D61) */}
      {autoWake ? <AutoWakeCard wake={autoWake} onDone={() => void reload()} /> : null}

      {/* 기상 알람을 끈 뒤 판정 중이면 H08로 다시 들어가는 길 */}
      {wake ? (
        <Card onPress={() => router.push({ pathname: '/wake', params: { alarm: wake.alarmId } })} accessibilityLabel="기상 확인 중, 보기">
          <View style={styles.banner}>
            <View style={styles.bannerText}>
              <Text variant="bodyStrong">기상 확인 중</Text>
              <Text variant="small" tone="sub">
                {wake.appointmentTitle} · {wake.phase === 'prompt' ? '조건을 채우지 못해 확인 알림을 보냈어요' : '알람을 끈 뒤 폰 사용을 보고 있어요'}
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
          <RoutineCard routine={routine} onPress={tickRoutine} onVoice={() => router.push('/routine-run')} />
        </>
      ) : null}

      {/* 준비물은 늘 보임 — 비어도 "챙길 준비물이 없어요" (AI 대화에서 말한 준비물이 바로 여기 들어옴) */}
      <SectionHeader title={evening ? '내일 준비물' : '오늘 준비물'} right={`${todos.filter((x) => x.done).length}/${todos.length}`} />
      <Card>
        <TodoList todos={todos} onToggle={tickTodo} />
      </Card>

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

      {/* 나의 기록 (R02) — 기록 탭을 없애고 홈 맨 아래로 (D110) */}
      <RecordsSection register={registerRecords} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  links: { flexDirection: 'row', gap: 14 },
  title: { marginTop: 8, marginBottom: 4 },
  ctaText: { marginTop: 4 },
  ctaButton: { marginTop: 12 },
  cardSub: { marginTop: 2 },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  bannerText: { flex: 1 },
});
