import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text, toast } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { ackRing, dismissRing, getRing, snoozeRing, startRing, stopRing } from '@/features/alarm/api';
import { getLocationStatus } from '@/features/location/permissions';
import { getLocationAuto } from '@/features/location/store';
import { listTodos, toggleTodo } from '@/features/routine/api';
import type { Todo } from '@/features/routine/types';
import { VoiceWave } from '@/features/alarm/components/VoiceWave';
import { useNextRing } from '@/features/alarm/hooks/useNextRing';
import { ringExit, type RingExit } from '@/features/alarm/ringExit';
import { isPreviewAlarmId } from '@/features/alarm/ringPreview';
import { snoozeView } from '@/features/alarm/snooze';
import type { Appointment, RingInfo, RingKind } from '@/features/alarm/types';
import { useSky } from '@/features/sky/hooks/useSky';
import { mixHex, skyAccent, skyTop } from '@/features/sky/sky';
import { getGroupSummary, listGroups } from '@/features/social/api';
import { groupWakeLine } from '@/features/social/wakeTexts';
import { isDevAlarmId } from '@/lib/alarmSync/devAlarm';
import { formatTime, timeParts } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// 알람 코어의 순수 계산 파일만 직접 가져옴 (index는 네이티브 모듈을 찾으므로 — 같은 선례: lib/alarmSync 시험)
import {
  canSnooze,
  SNOOZE_LATE_CHIP,
  SNOOZE_MINUTES_OPTIONS,
  snoozeCountLabel,
  snoozeLateLine,
  snoozeLimitNotice,
  wakeNowBanner,
} from '../../modules/alarm-core/src/plan';

const HEAD: Record<RingKind, string> = {
  WAKE: '일어날 시간이에요',
  PREPARE: '준비할 시간이에요',
  DEPARTURE: '출발할 시간이에요',
};
// 바탕 = 어두운 잉크에 그 시각 하늘의 포인트 색을 섞음 — 하늘 계열이지만 흰 글자 대비 8 : 1 이상 (하늘 20종 x 3단계 모두 확인)
//   종류 구분은 섞는 양(밝기)으로: 기상이 가장 어둡고 출발이 가장 밝음
const SKY_MIX: Record<RingKind, number> = { WAKE: 0.45, PREPARE: 0.55, DEPARTURE: 0.65 };
const WARN_TEXT_MIX = 0.6; // 경고색에 흰색을 섞어 어두운 바탕 위에서도 글자로 읽히게 (대비 4.5 : 1 이상)

// 같이 준비하는 사람 한 줄 — 일정에는 그룹 이름만 있어 이름으로 그룹을 찾음. 못 읽으면 null (줄을 안 그림)
async function loadTogether(groupName: string | null): Promise<string | null> {
  if (!groupName) return null;
  const group = (await listGroups(null)).find((g) => g.name === groupName);
  const summary = group ? await getGroupSummary(group.id, null) : null;
  if (!summary) return null;
  const line = groupWakeLine(summary.wokeCount, summary.trip);
  return line ? `${summary.name} · ${line}` : summary.name;
}

// H07 알람 울림 — 실데이터에서는 알람이 울릴 때 알람 코어의 길잡이 화면이 이 화면(/ring?alarm=<알람 id>)을 잠금화면 위로 불러 옴 (#332)
//   소리 · 진동 · 다시 울림은 코어가 하고, 이 화면은 값을 코어에서 읽어(getRing) 그리고 해제 · 미루기를 코어에 시킴. 데이터가 뜨면 ackRing으로 "H07 떴음"을 알림
//   앱이 못 뜨면 코어의 네이티브 대체 화면이 해제 · 미루기를 함. 웹 · 가짜 데이터: /ring?alarm=a1:WAKE (가짜 데이터가 값을 채움)
// 미루기 규칙(D3 기본안 A)은 네이티브 화면과 같음 — 5 · 10 · 15분 중 고르기, 알람 한 개당 3번까지 ("미루기 N/3회"),
//   한도에 닿으면 미루기를 끄고 "지금 바로 준비 · 출발 시각".
//   늦어요는 막지 않고 보여 주기만 함: 늦는 칩은 경고색 + 칩 안 "늦어요", 고른 칩이 늦으면 미루기 버튼 위에 경고 한 줄 · 버튼 "N분 미루기 · 늦어요",
//   5분만 미뤄도 늦으면 시각 위에 "지금 일어나야 9:00 출발에 맞아요" 띠 (계산은 알람 코어의 순수 함수 → features/alarm/snooze.ts)
// 준비 · 출발 알람의 머리글은 폰 알림과 같은 글자(data.notice, 서버 알림 문구 함수) — 없으면 종류별 기본 머리글
export default function RingScreen() {
  const params = useLocalSearchParams<{ alarm?: string }>();
  const alarmId = params.alarm ?? 'a1:WAKE';
  const { data: loaded, error, reload } = useLoad(() => getRing(alarmId));
  // 실데이터는 해제 · 미루기 뒤 코어에서 울리는 알람이 사라져 다시 읽으면 null — 처음 읽은 값을 들고 있어 화면이 "찾을 수 없어요"로 바뀌지 않게
  const [firstLoaded, setFirstLoaded] = useState<RingInfo | null>(null);
  if (loaded && loaded.alarmId === alarmId && firstLoaded?.alarmId !== alarmId) setFirstLoaded(loaded);
  const data = loaded === null && firstLoaded?.alarmId === alarmId ? firstLoaded : loaded?.alarmId === alarmId || loaded == null ? loaded : undefined;
  const preview = !isMock() && data != null && isPreviewAlarmId(data.alarmId); // 웹 실데이터 미리보기 — 저장된 일정으로 보여 주기만, 기록 없음 (ringPreview.ts). 가장 가까운 알람으로 바뀐 경우도 읽은 알람 id로 앎
  // 읽는 동안에도 맞는 배경이 보이게 알람 id(<일정>:<종류>)의 종류를 먼저 씀
  const fromId = params.alarm?.split(':')[1];
  const kind: RingKind = data?.kind ?? (fromId && Object.keys(HEAD).includes(fromId) ? (fromId as RingKind) : 'WAKE');
  const sky = useSky();
  const bg = mixHex(colors.ink, skyAccent(skyTop(sky.kind, sky.phase)), SKY_MIX[kind]);
  const warnText = mixHex(colors.warn, colors.inverse, WARN_TEXT_MIX);
  const groupName = data?.appointment.groupName ?? null;
  // 읽은 줄은 어느 그룹 것인지와 같이 둠 — 알람이 바뀌면 앞 그룹 줄이 남지 않게
  const [togetherRead, setTogetherRead] = useState<{ group: string | null; line: string | null } | null>(null);
  const together = togetherRead?.group === groupName ? togetherRead.line : null;
  useEffect(() => {
    let alive = true;
    loadTogether(groupName).then(
      (line) => alive && setTogetherRead({ group: groupName, line }),
      () => undefined, // 덧붙임 줄이라 못 읽어도 화면은 그대로
    );
    return () => {
      alive = false;
    };
  }, [groupName]);
  const [done, setDone] = useState(false); // 준비 · 출발 알람을 끈 뒤 — 안내를 화면에 남김
  const handled = useRef(false); // 두 번 눌러도 해제 · 미루기는 한 번만 기록
  const [finished, setFinished] = useState(false); // 해제 · 미루기를 마침 — 뒤로 가기를 다시 풂 (이동이 막혀도 화면에 갇히지 않게)
  const auth = useAuth();
  // 끈 뒤 갈 곳 — 로그인 전 · 시험 알람이면 홈 · 기상 확인이 막혀 있어 다른 곳으로 (features/alarm/ringExit.ts)
  const exitFor = (action: 'dismiss' | 'snooze' | 'done', ringKind: RingKind): RingExit =>
    ringExit(ringKind, action, {
      devAlarm: isDevAlarmId(alarmId),
      enabled: auth.enabled,
      signedIn: auth.session != null,
      needsOnboarding: auth.needsOnboarding,
      needsReconsent: auth.needsReconsent,
    });

  // 같은 /ring 화면에 다른 알람의 딥링크가 와서 주소의 alarm만 바뀌면(앞 알람이 낡은 채 남은 경우) 다시 읽음 (#332 로컬 리뷰)
  const lastAlarmId = useRef(alarmId);
  useEffect(() => {
    if (lastAlarmId.current === alarmId) return;
    lastAlarmId.current = alarmId;
    handled.current = false;
    setFinished(false);
    void reload();
  }, [alarmId, reload]);

  // 울리는 동안 안드로이드 뒤로 가기는 막음 — 해제 · 미루기 없이 나가면 알람이 그냥 사라짐 (웹은 해당 없음)
  const ringing = data != null && !done && !finished;
  useEffect(() => {
    if (Platform.OS === 'web' || !ringing) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [ringing]);

  // 울림을 읽은 뒤 내 상태를 '알람 울리는 중'으로 (기상 알람만), 미루기 · 해제 없이 나가면(안드로이드 · 웹 뒤로 가기) 그 표시만 지움
  // 불러오는 함수가 아니라 여기서 시작해야, 읽는 도중에 나가도 지우기가 시작보다 먼저 돌지 않음
  const ringId = data?.alarmId ?? null;
  const ringAt = data?.at.getTime() ?? null;
  useEffect(() => {
    if (!ringId || ringAt == null) return;
    void startRing(ringId, new Date(ringAt));
    return () => {
      if (!handled.current) void stopRing(ringId);
    };
  }, [ringId, ringAt]);

  // H07이 떴다고 코어의 길잡이 화면에 알림 (실데이터만). 앱이 이미 앞에 있어도 알림을 눌러 길잡이가 다시 열리면 앱이 앞으로 와서 다시 알림
  const shownId = data?.alarmId ?? null;
  useEffect(() => {
    if (!shownId || isPreviewAlarmId(shownId)) return; // 웹 미리보기는 길잡이 화면이 없음
    ackRing(shownId);
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') ackRing(shownId);
    });
    return () => sub.remove();
  }, [shownId]);

  // 미루기는 3번까지 — 실데이터에서는 알람 코어가 셈 (웹 미리 보기에서는 가짜 데이터가 셈)
  const snoozeAllowed = data != null && canSnooze(data.snoozeCount, data.snoozeLimit);
  const view = data ? snoozeView(data) : null;
  const departClock = data?.departAt ? timeParts(data.departAt).hm : null; // "9:00"
  // 경고 한 줄 — 가장 짧은 미루기가 늦을 때만 ("5분 미루면 9:00 출발보다 5분 늦어요")
  const firstChip = view?.chips[0];
  const lateLine = firstChip && firstChip.lateMinutes > 0 && departClock ? snoozeLateLine(firstChip.minutes, departClock, firstChip.lateMinutes) : null;
  async function snooze(minutes: number) {
    if (!data || handled.current || !canSnooze(data.snoozeCount, data.snoozeLimit)) return;
    handled.current = true;
    if (preview) {
      // 웹 미리보기는 코어 · 서버에 미루기를 남기지 않음 — 안내만 하고 나감
      toast('미리보기라 다시 울리지 않아요');
      backOrHome();
      return;
    }
    let snoozed = false;
    try {
      snoozed = await snoozeRing(data.alarmId, minutes, data.at);
    } catch {
      // 알람 코어 호출이 던짐(옛 APK · 네이티브 오류) — 다시 누를 수 있게 풀어 둠
    }
    if (!snoozed) {
      // 한도 · 이미 멈춤 — 알람 코어가 거절함. 다시 누를 수 있게 풀어 둠
      handled.current = false;
      toast('미루지 못했어요. 알람 해제로 꺼 주세요');
      return;
    }
    toast(`${minutes}분 뒤 다시 울려요`);
    setFinished(true);
    // 해제처럼 스택을 홈으로 정리 — 울림 화면 밑에 이전 해제의 기상 확인(H08) 등이 남아 있으면 backOrHome이 그리로 돌아감 (L8 3차)
    // 로그인 전 · 시험 알람이면 홈이 막혀 있어 로그인 · 알람 테스트 화면으로 (ringExit)
    leaveRing(exitFor('snooze', data.kind));
  }

  // 기상 알람을 끄면 기상 확인(H08)으로, 준비 · 출발은 결과 안내 화면
  // 끈 시각 = 지금 울리는 시각 — 기상 확인이 이 시각부터 10분을 봄
  async function dismiss() {
    if (!data || handled.current) return;
    handled.current = true;
    try {
      await dismissRing(data.alarmId, data.at);
    } catch {
      // 알람 코어 호출이 던짐 — 다시 누를 수 있게 풀고 알림. 안 풀면 알람은 울리는데 앱에서 끌 방법이 없음
      handled.current = false;
      toast('알람을 끄지 못했어요. 다시 눌러 주세요');
      return;
    }
    setFinished(true);
    const exit = exitFor('dismiss', data.kind);
    if (data.kind === 'WAKE' || exit.href !== '/') {
      // 목업 A.dismiss처럼 [홈, 기상 확인] — 기상 확인에서 뒤로 가면 홈. 로그인 전 · 시험 알람은 열 수 있는 화면으로 (ringExit)
      leaveRing(exit, data.alarmId);
      return;
    }
    // 준비 · 출발은 잠깐 뜨는 토스트 대신 화면에 안내를 남기고 "확인"으로 홈에
    setDone(true);
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: bg }]} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      {data && done && data.kind !== 'WAKE' ? (
        <DonePanel bg={bg} kind={data.kind} appointment={data.appointment} next={preview ? data.alarmId : null} onClose={() => leaveRing(exitFor('done', data.kind))} />
      ) : data ? (
        <View style={styles.body} accessibilityRole="alert" accessibilityLabel={data.notice ?? HEAD[kind]}>
          <View style={styles.top}>
            <View />
            {preview ? (
              <Text variant="caption" tone="inverse" style={styles.faded65}>
                미리보기 · 기록 안 남음
              </Text>
            ) : null}
            {data.important ? (
              <View style={styles.chip}>
                <Text variant="label" tone="inverse">
                  중요 일정
                </Text>
              </View>
            ) : null}
          </View>

          <Text variant="bodyLarge" tone="inverse" align="center" style={styles.head}>
            {data.notice ?? HEAD[kind]}
          </Text>
          {view?.wakeNow && departClock ? (
            <View style={styles.warnStrip} accessibilityRole="alert">
              <Text variant="bodyStrong" align="center" style={{ color: warnText }}>
                {wakeNowBanner(departClock)}
              </Text>
            </View>
          ) : null}
          <Text variant="ringTime" tone="inverse" align="center" style={styles.time}>
            {timeParts(data.at).hm}
          </Text>
          <Text variant="big" tone="inverse" align="center" weight={600} style={styles.title}>
            {data.appointment.title}
          </Text>
          {data.appointment.place ? (
            <Text variant="small" tone="inverse" align="center" style={styles.faded65}>
              {formatTime(data.appointment.at)} · {data.appointment.place}
            </Text>
          ) : null}
          {together ? (
            <Text variant="caption" tone="inverse" align="center" style={styles.together}>
              {together}
            </Text>
          ) : null}

          {/* 알람 코어는 음성 문장을 안 가져서(실데이터) 비어 있으면 안내 칸을 그리지 않음 */}
          {data.voiceLine ? (
            <View style={styles.voice}>
              <Text variant="label" tone="inverse" style={styles.faded65}>
                음성 안내 · {data.voiceTone}
              </Text>
              <Text variant="reading" tone="inverse" style={styles.voiceText}>
                “{data.voiceLine}”
              </Text>
              <VoiceWave />
            </View>
          ) : null}

          <View style={styles.bottom}>
            {snoozeAllowed ? null : (
              <Text variant="bodyStrong" tone="inverse" style={styles.limitNotice}>
                {snoozeLimitNotice(data.departAt ? formatTime(data.departAt) : null)}
              </Text>
            )}
            {/* 미루기 한 겹 — 칩을 누르면 그 시간만큼 바로 미룸. 늦는 칩은 칩 안 작은 글자로만 표시 */}
            <View style={styles.optionsHead}>
              <Text variant="label" tone="inverse" style={styles.faded70}>
                미루기
              </Text>
              <Text variant="caption" tone="inverse" style={styles.faded70}>
                {snoozeCountLabel(data.snoozeCount, data.snoozeLimit)}
              </Text>
            </View>
            <View style={styles.options}>
              {SNOOZE_MINUTES_OPTIONS.map((m) => {
                const late = (view?.chips.find((chip) => chip.minutes === m)?.lateMinutes ?? 0) > 0;
                return (
                  <Pressable
                    key={m}
                    onPress={() => void snooze(m)}
                    disabled={!snoozeAllowed}
                    accessibilityRole="button"
                    accessibilityLabel={`${m}분 미루기${late ? ` · ${SNOOZE_LATE_CHIP}` : ''}`}
                    accessibilityState={{ disabled: !snoozeAllowed }}
                    style={[styles.option, !snoozeAllowed && styles.disabled]}
                  >
                    <Text variant="body" tone="inverse" weight={600}>
                      {m}분
                    </Text>
                    {/* 칩 안 '늦어요'는 폰 알람 화면(네이티브 AlarmRingingActivity)과 같게 둠 — 글자만 12로 (C-05) */}
                    {late ? (
                      <Text variant="label" weight={700} tone="inverse" style={styles.faded70}>
                        {SNOOZE_LATE_CHIP}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {lateLine ? (
              <Text variant="bodyStrong" align="center" style={[styles.warnLine, { color: warnText }]} accessibilityRole="alert">
                {lateLine}
              </Text>
            ) : null}
            <Pressable onPress={dismiss} accessibilityRole="button" style={[styles.button, styles.main]}>
              <Text variant="button" style={{ color: bg }}>
                알람 해제
              </Text>
            </Pressable>
          </View>
        </View>
      ) : data === null || (data === undefined && error) ? (
        // 웹 미리 보기에서 알람 id가 틀렸거나 도착(울리지 않는 알림)일 때
        <View style={styles.missing}>
          <Text variant="body" tone="inverse" align="center">
            울릴 알람을 찾을 수 없어요
          </Text>
          <Pressable onPress={() => leaveRing(exitFor('done', kind))} accessibilityRole="button" style={[styles.button, styles.closeButton]}>
            <Text variant="button" style={{ color: bg }}>
              닫기
            </Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

// 울림 화면을 떠남 — 홈이면 스택을 홈까지 걷어 냄(+ 기상 확인), 그 밖(로그인 · 온보딩 · 알람 테스트)은 지금 화면을 바꿈
//   알람 테스트는 보통 울림 화면 바로 밑에 있어 뒤로 감 (바꾸면 같은 화면이 두 번 쌓임)
function leaveRing(exit: RingExit, wakeAlarmId?: string) {
  if (exit.href === '/') {
    router.dismissTo('/');
    if (exit.openWake && wakeAlarmId) router.push({ pathname: '/wake', params: { alarm: wakeAlarmId } });
    return;
  }
  if (exit.href === '/dev/alarm-test' && router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(exit.href);
}

// 준비 · 출발 알람을 끈 뒤 안내 — 준비물 체크(준비) · 이동 시간과 도착 목표(출발), "확인"을 누르면 홈
// next = 웹 미리보기에서 이어 볼 알람의 기준(지금 끈 알람 id) — 있으면 [다음 알람 울려 보기]
function DonePanel({ bg, kind, appointment: a, next: from, onClose }: { bg: string; kind: Exclude<RingKind, 'WAKE'>; appointment: Appointment; next: string | null; onClose: () => void }) {
  const [checked, setChecked] = useState<string[]>([]);
  const next = useNextRing(from);
  // 홈 '오늘 준비물'과 같은 할 일(todos)을 씀 — 여기서 체크하면 홈에도 체크됨. 못 읽거나 비었으면 일정에 적은 준비물 이름으로
  const { data: todos, reload: reloadTodos } = useLoad(() => (kind === 'PREPARE' ? listTodos(a.at) : Promise.resolve<Todo[]>([])));
  // 출발 안내는 위치 감지가 켜져 있을 때만 "자동으로 기록돼요"라고 말함
  const { data: locationOn } = useLoad(async () => {
    if (kind !== 'DEPARTURE') return false;
    return (await getLocationStatus()) === 'on' && (await getLocationAuto().catch(() => false));
  });
  const toggleItem = (todo: Todo) => {
    void toggleTodo(todo.id)
      .then(() => reloadTodos())
      .catch(() => toast('체크하지 못했어요. 다시 눌러 주세요'));
  };
  const rows: { key: string; name: string; on: boolean; press: () => void }[] =
    todos && todos.length > 0
      ? todos.map((t) => ({ key: t.id, name: t.title, on: t.done, press: () => toggleItem(t) }))
      : a.items.map((name) => {
          const on = checked.includes(name);
          return { key: name, name, on, press: () => setChecked((list) => (on ? list.filter((x) => x !== name) : [...list, name])) };
        });
  const arrive = a.alarms.find((x) => x.kind === 'ARRIVE');
  return (
    <View style={styles.body}>
      <View style={styles.top}>
        <View />
      </View>
      <Text variant="bodyLarge" tone="inverse" align="center" style={styles.head}>
        {kind === 'PREPARE' ? '준비를 시작해요' : '출발해요'}
      </Text>
      <Text variant="big" tone="inverse" align="center" weight={600} style={styles.title}>
        {a.title}
      </Text>
      <Text variant="small" tone="inverse" align="center" style={styles.faded65}>
        {a.place ? `${formatTime(a.at)} · ${a.place}` : formatTime(a.at)}
      </Text>

      <View style={styles.voice}>
        {kind === 'PREPARE' ? (
          <>
            <Text variant="label" tone="inverse" style={styles.faded65}>
              챙길 준비물
            </Text>
            {rows.length ? (
              rows.map(({ key, name, on, press }) => {
                return (
                  <Pressable
                    key={key}
                    onPress={press}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={styles.checkRow}
                  >
                    <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                      {on ? (
                        <Text variant="label" style={{ color: bg }}>
                          ✓
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="reading" tone="inverse" style={on && styles.checked}>
                      {name}
                    </Text>
                  </Pressable>
                );
              })
            ) : (
              <Text variant="reading" tone="inverse" style={styles.voiceText}>
                챙길 준비물이 없어요. 준비를 시작해요.
              </Text>
            )}
          </>
        ) : (
          <>
            <Text variant="label" tone="inverse" style={styles.faded65}>
              이동
            </Text>
            <Text variant="reading" tone="inverse" style={styles.voiceText}>
              이동 {a.travelMinutes}분{arrive ? ` · 도착 목표 ${formatTime(arrive.at)}` : ''}
            </Text>
            <Text variant="note" tone="inverse" style={[styles.voiceText, styles.faded65]}>
              {locationOn ? '집을 벗어나면 출발이 자동으로 기록돼요.' : '위치 감지를 켜 두면 집을 벗어날 때 출발이 자동으로 기록돼요.'}
            </Text>
          </>
        )}
      </View>

      <View style={styles.bottom}>
        {next ? (
          <Pressable onPress={next.open} accessibilityRole="button" style={[styles.button, styles.closeButton, styles.nextButton]}>
            <Text variant="button" style={{ color: bg }}>
              {next.label}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} accessibilityRole="button" style={[styles.button, styles.closeButton]}>
          <Text variant="button" style={{ color: bg }}>
            확인
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, paddingTop: 10, paddingHorizontal: 22, paddingBottom: 28 },
  missing: { flex: 1, justifyContent: 'center', gap: 16, paddingHorizontal: 22 },
  closeButton: { backgroundColor: colors.inverse },
  nextButton: { marginBottom: 10 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 26 },
  chip: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.ringLine,
    justifyContent: 'center',
  },
  head: { marginTop: 30, opacity: 0.8 },
  time: { marginTop: 4 },
  title: { marginTop: 14, marginBottom: 2 },
  voice: { marginTop: 22, backgroundColor: colors.ringPanel, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 18 },
  voiceText: { marginTop: 6 },
  bottom: { marginTop: 'auto' },
  optionsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  limitNotice: { marginTop: 8 },
  options: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 8, marginBottom: 14 },
  warnStrip: { marginTop: 14, paddingVertical: 6 },
  warnLine: { marginBottom: 12 },
  together: { marginTop: 6, opacity: 0.75 },
  disabled: { opacity: 0.35 },
  option: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 4,
    borderRadius: 14, // 알약이 아니라 모서리 둥근 네모
    backgroundColor: colors.ringOption,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: { height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  main: { backgroundColor: colors.inverse },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  checkBox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.ringLine, alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: colors.inverse, borderColor: colors.inverse },
  checked: { textDecorationLine: 'line-through', opacity: 0.6 },
  faded60: { opacity: 0.6 },
  faded65: { opacity: 0.65 },
  faded70: { opacity: 0.7 },
});
