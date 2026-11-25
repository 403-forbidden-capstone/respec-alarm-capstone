import { prepareRecentLabel, prepareSourceLabel } from '@shared/calc/prepare.ts';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Card, Chip, DateSheet, EmptyState, KeyValueRow, Loading, LoadError, Screen, Sheet, Stepper, Text, toast, Toggle, TopBar } from '@/components/ui';
import { getAppointment, listOccurrences, listPlaces, listStandaloneWakes, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { canConfirmPrepStartAt, confirmPrepStartSelfReport, loadPrepStartSelfReport } from '@/features/alarm/selfReportedPrep';
import { isManualTime, linkWakeTimes, manualTimes, moveAlarm, orderError, resetAlarm, sameEdits, shownPreview, timeInputsChanged } from '@/features/alarm/adjust';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import { OccurrenceList } from '@/features/alarm/components/OccurrenceList';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { RepeatScopeSheet } from '@/features/alarm/components/RepeatScopeSheet';
import { ScheduleEditSheet } from '@/features/alarm/components/ScheduleEditSheet';
import { SelectRow } from '@/features/alarm/components/SelectRow';
import { TextLink } from '@/features/alarm/components/TextLink';
import { previewAlarmId } from '@/features/alarm/ringPreview';
import { saveNotice } from '@/features/alarm/saveNotice';
import { TimeButton } from '@/features/alarm/components/TimeButton';
import { TimeSheet } from '@/features/alarm/components/TimePicker';
import { useScheduleEdit } from '@/features/alarm/hooks/useScheduleEdit';
import { changedAlarms, needsMoveConfirm, ringingKinds, type AlarmChange } from '@/features/alarm/schedule';
import { TRAVEL_CONFIRM_EDIT, TRAVEL_CONFIRM_OK, TRAVEL_PROBLEM_NOTE, TravelConfirmNeeded, travelConfirmMessage, type TravelFallback } from '@/features/alarm/travelConfirm';
import {
  AXES,
  IMPORTANCE_LABEL,
  KIND_LABEL,
  LEVELS,
  MANUAL_SOURCE,
  ORIGIN_HOME,
  PLACE_PENDING_LABEL,
  TRANSPORT_OPTIONS,
  type AlarmEdits,
  type AlarmKind,
  type AlarmPreview,
  type AppointmentDetail,
  type IntensityAxis,
  type Level,
  type RingKind,
  type StandaloneWake,
  type Transport,
} from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { ALARM_AXES_PICKER, PREP_START_SELF_REPORT_PILOT } from '@/lib/flags';
import { useAuth } from '@/features/auth/AuthProvider';
import { addMinutes, formatDateShort, formatTime, startOfDay } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const LEVEL_OPTIONS = LEVELS.map((l, i) => [i as Level, l.name] as const);

type Levels = Record<IntensityAxis, Level | null>; // null = 자동

// H03 알람 설정 — 연결 일정 · 이동 조건 · 준비 시간 · 여유 · 알람 시각 · 강도를 바꾸면 알람을 다시 계산
// 출발 위치 · 이동 수단 · 이동 · 준비 시간 · 알람 시각은 직접 고를 수 있고(D42 C), 직접 고른 값은 "직접 고름"으로 표시하며 자동 계산보다 먼저 씀
// 모두 초안으로 들고 있다가 "저장"에서 한 번에 반영 (고친 값은 고친 값 기록에 남음)
export default function AlarmDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getAppointment(id, { withoutAlarms: true })); // 알람 없는 일정도 엶 — 장소를 정하고 알람을 만듦 (D41 A)

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H03" />
        {error ? <LoadError onRetry={reload} /> : <Loading text="알람 설정을 불러오는 중" />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H03" />
        <Text variant="body" tone="sub">
          일정을 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }
  return <Detail key={data.id} appointment={data} reload={reload} />;
}

// 저장된 값에서 초안의 처음 모양을 만듦
const savedKinds = (a: AppointmentDetail) => Object.fromEntries(ringingKinds(a.alarms).map((x) => [x.kind, x.enabled])) as Partial<Record<AlarmKind, boolean>>;
const savedLevels = (a: AppointmentDetail): Levels => ({
  sound: a.intensity.axes.sound.manual ? a.intensity.axes.sound.level : null,
  voice: a.intensity.axes.voice.manual ? a.intensity.axes.voice.level : null,
  vibration: a.intensity.axes.vibration.manual ? a.intensity.axes.vibration.level : null,
});
const savedPreview = (a: AppointmentDetail): AlarmPreview => ({
  alarms: a.alarms,
  travelMinutes: a.travelMinutes,
  travelSource: a.travelSource,
  autoTravelMinutes: a.auto.travelMinutes,
  predictedPrepMinutes: a.predictedPrepMinutes,
  autoPredictedPrepMinutes: a.auto.predictedPrepMinutes,
});

function Detail({ appointment: a, reload }: { appointment: AppointmentDetail; reload: () => Promise<boolean> }) {
  const { session } = useAuth();
  const pilot = PREP_START_SELF_REPORT_PILOT && session?.user.email === 'demo-me@example.com' && a.groupName == null;
  const { data: prepStartReport, reload: reloadPrepStartReport } = useLoad(() =>
    pilot ? loadPrepStartSelfReport(a.id) : Promise.resolve(null),
  );
  const [reportedAt, setReportedAt] = useState<string | null>(null);
  const startAlreadyReported = reportedAt ?? prepStartReport?.self_reported_prep_started_at ?? null;
  const canReportNow = canConfirmPrepStartAt(a.at, now());
  const [edits, setEdits] = useState<AlarmEdits>(a.edits);
  const [kinds, setKinds] = useState(() => savedKinds(a));
  const [levels, setLevels] = useState(() => savedLevels(a));
  const [preview, setPreview] = useState<AlarmPreview>(() => savedPreview(a));
  const [changes, setChanges] = useState<AlarmChange[] | null>(null); // 확인 시트에 보여 줄 바뀌는 알람
  const [travelConfirm, setTravelConfirm] = useState<TravelFallback | null>(null); // 길찾기를 못 해 어림값을 확인받는 시트 (실데이터)
  const [pickKind, setPickKind] = useState<RingKind | null>(null); // 시각을 고르는 시트가 열린 알람
  // 알람 없는 일정(장소 미정 · 장소를 나중에 정함 · 알람 없이 저장) — 알람 칸 없이 열고(D41 A), [알람 계산해 보기]를 눌러야 미리 보기 · 저장
  const noAlarms = !a.alarms.length;
  const placePending = !a.place; // 장소 미정이면 이동시간을 구할 수 없어 계산하지 않음
  const [showAlarms, setShowAlarms] = useState(!noAlarms);
  // 같은 날 일정 없는 기상 알람 — 이 일정에 기상이 새로 생기면 저장 전에 합칠지 따로 둘지 물음. 고른 답: 알람 = 합침, null = 따로 둠, undefined = 아직 안 물음
  const [wakeDup, setWakeDup] = useState<StandaloneWake[] | null>(null);
  const [wakeChoice, setWakeChoice] = useState<StandaloneWake | null | undefined>(undefined);
  const { data: places } = useLoad(listPlaces);
  // 반복 일정의 앞으로 회차 — 덧붙임 줄이라 못 읽어도 화면은 그대로 (없는 것으로). 둘 이상일 때만 보임
  const { data: occurrences, reload: reloadOccurrences } = useLoad(() => listOccurrences(a.id));
  const [showAllOccurrences, setShowAllOccurrences] = useState(false);
  const { busy, run } = useAction();
  const edit = useScheduleEdit({ appointment: a, reload: () => Promise.all([reload(), reloadOccurrences()]) }); // 연결 일정 카드 → 일정 편집 시트 · 삭제 되돌리기
  const setEdit = (patch: Partial<AlarmEdits>) => setEdits((e) => ({ ...e, ...patch }));

  // 저장된 값과 다른 곳이 있으면 저장 전 — 저장 버튼이 켜지고, 나갈 때 한 번 물음
  const saved = savedKinds(a);
  const savedLv = savedLevels(a);
  const dirty =
    (noAlarms && preview.alarms.length > 0) || // 알람 없는 일정에 계산한 알람이 있으면 저장(만들기)할 수 있음
    !sameEdits(edits, a.edits) ||
    ringingKinds(a.alarms).some((x) => kinds[x.kind] !== saved[x.kind]) ||
    AXES.some(([axis]) => levels[axis] !== savedLv[axis]);
  useLeaveGuard(dirty && !edit.deleted); // 지운 일정이면 H03 초안은 의미가 없어 나갈 때 묻지 않음

  // 값을 바꾸면 알람 시각을 다시 계산 (저장 전 미리 보기)
  useEffect(() => {
    if (!showAlarms) return;
    let cancelled = false;
    previewAlarms(a.id, edits)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      // 실데이터 계산이 실패하면(네트워크 등) 이전 미리 보기를 그대로 둠 — 저장할 때 다시 계산하며 이유를 알려 줌
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [a.id, edits, a.alarms, showAlarms]);

  const view = noAlarms ? preview : shownPreview(edits, a.edits, savedPreview(a), preview); // 입력을 안 바꿨으면 저장된 알람 시각 (adjust.ts). 알람 없는 일정은 계산한 값
  const wakeAdded = !a.alarms.some((x) => x.kind === 'WAKE') && view.alarms.some((x) => x.kind === 'WAKE') && kinds.WAKE !== false; // 이번 저장으로 기상이 새로 생김
  const first = view.alarms[0] ?? a.alarms[0];
  const missingWake = !view.alarms.some((x) => x.kind === 'WAKE') && view.alarms.some((x) => x.kind !== 'ARRIVE'); // 울릴 알람은 있는데 기상만 없음
  const blocked = orderError(view.alarms); // 순서가 뒤집히면 저장을 막음
  const manualAny = view.alarms.some(isManualTime);
  const anyManual = AXES.some(([axis]) => levels[axis] != null);
  const travel = edits.travelMinutes ?? view.autoTravelMinutes;
  const prepare = edits.prepareMinutes ?? view.autoPredictedPrepMinutes;
  const recentLine = view.prepareSampleCount != null ? prepareRecentLabel(view.prepareRecent ?? []) : null;
  const margin = a.auto.predictedPrepMinutes - a.beforePrepMinutes - a.prepMinutes;
  const originOptions = [ORIGIN_HOME, ...(places ?? []).map((p) => p.name), edits.origin]
    .filter((name, i, all) => all.indexOf(name) === i)
    .map((name) => [name, name] as const);
  // 계산식의 기준 알람 — 그날 첫 일정이면 기상, 아니면 준비. 직접 고른 알람 시각이 있어도 식은 자동 계산 그대로
  // 준비가 기상을 따라가는 일정인지 — 서버 미리 보기가 알려 줌(따로 울리는 기상이면 false, #624). DB 행만으로는 알 수 없어 저장된 값은 대신 씀
  const followsWake = view.withWake ?? a.withWake;
  const baseKind: AlarmKind = followsWake ? 'WAKE' : 'PREPARE';
  const base = addMinutes(a.at, -(edits.bufferMinutes + travel + prepare));
  const picking = pickKind ? view.alarms.find((x) => x.kind === pickKind) : undefined;

  // travelMinutes = 확인 시트에서 사용자가 확인한 어림 이동시간 — 예상 이동에 직접 입력한 값으로 넣어 저장(MANUAL)
  //   choice = 같은 날 일정 없는 기상 알람을 합칠지(그 알람) · 따로 둘지(null) — 확인 시트에서 고른 값. 이동시간 · 시각 확인 시트를 거쳐 다시 불려도 고른 값을 씀
  async function apply(travelMinutes?: number, choice: StandaloneWake | null | undefined = wakeChoice) {
    // 미설정 기상을 켜서 생긴 기상(따로 울림, #624)이면 준비를 고정하지 않음 — 일정 시각이 바뀌면 준비 · 출발은 다시 계산
    const pickedWake = edits.times.WAKE != null && !a.alarms.some((x) => x.kind === 'WAKE');
    const link = choice ? { times: pickedWake ? { ...edits.times, WAKE: choice.at } : linkWakeTimes(view.alarms, edits.times, choice.at), linkWakeAlarmId: choice.id } : {};
    const draft = { ...edits, ...(travelMinutes != null ? { travelMinutes } : {}), kinds, levels, ...link };
    const moved = timeInputsChanged(draft, a.edits);
    let result: Awaited<ReturnType<typeof saveAlarmSettings>>;
    try {
      result = await saveAlarmSettings(a.id, draft);
    } catch (e) {
      // 길찾기를 못 해 서버가 어림값만 가졌음 — 저장하지 않고 이 값으로 할지 물음 (알람 시각 확인 시트가 떠 있었으면 닫고)
      if (e instanceof TravelConfirmNeeded) {
        setChanges(null);
        setTravelConfirm({ minutes: e.minutes, source: e.source });
        return;
      }
      setWakeChoice(undefined); // 저장이 안 됐으면 다음 저장에서 기상 합치기를 다시 물음
      throw e;
    }
    const { turnedOff, turnedOn } = result;
    setChanges(null);
    setTravelConfirm(null);
    setWakeChoice(undefined);
    // 확인한 이동시간은 이제 직접 입력으로 저장됨 — 화면의 초안도 같은 값으로 맞춰 "저장 전" 표시(저장 버튼 · 나갈 때 묻기)가 남지 않게
    if (travelMinutes != null) setEdit({ travelMinutes });
    // 저장은 됐는데 폰에 못 건 알람이 있으면 그 사실을 먼저 (saveNotice.ts)
    toast(
      saveNotice(result.followUp, '저장했지만') ??
        (choice
          ? `${formatTime(choice.at)} 기상 알람을 이 일정의 기상 알람으로 합쳤어요`
          : noAlarms
            ? '알람을 만들었어요'
            : turnedOff
              ? '알람을 모두 꺼서 이 일정 알람이 꺼졌어요'
            : turnedOn
              ? '알람을 켜서 이 일정 알람도 다시 켰어요'
              : moved
                ? '알람 시각을 다시 계산했어요'
                : '저장했어요'),
    );
    await Promise.all([reload(), reloadOccurrences()]); // 저장으로 알람이 바뀌면 회차 목록의 첫 알람 시각도 다시
  }

  function save() {
    if (!dirty || blocked) return;
    void run(async () => {
      // 새 저장은 이전 저장 흐름의 합치기 선택을 쓰지 않음 — 매번 지금 사용자의 선택으로
      setWakeChoice(undefined);
      // 이 저장으로 기상이 새로 생기는데 같은 날 직접 만든 기상 알람이 있으면 먼저 물음 — 묻지 않고 지우거나 합치지 않음
      if (wakeAdded) {
        const wakes = await listStandaloneWakes(a.at);
        if (wakes.length) {
          setWakeDup(wakes);
          return;
        }
      }
      await confirmMoveOrApply(undefined);
    }, '저장하지 못했어요');
  }

  // 기상 확인 시트 바깥 누름 — 저장하지 않고 닫음, 고른 것 없음
  function closeWakeDup() {
    if (busy) return;
    setWakeDup(null);
    setWakeChoice(undefined);
  }

  // 기상 확인 시트에서 고름 — 합치기(그 알람) · 따로 두기(null)
  function pickWake(choice: StandaloneWake | null) {
    if (busy) return;
    setWakeDup(null);
    setWakeChoice(choice);
    void run(() => confirmMoveOrApply(choice), '저장하지 못했어요');
  }

  async function confirmMoveOrApply(choice: StandaloneWake | null | undefined) {
    // 여유 · 출발 위치 · 이동 수단 · 이동 · 준비로 알람 시각이 5분 이상 바뀌면 한 번 더 확인 — 여유를 1분 단위로 고쳐 5분 미만이면 묻지 않고 저장 (D12)
    //   미리 보기가 늦게 올 수 있어(실데이터는 서버 계산) 저장할 때 다시 계산한 값으로 비교
    if (timeInputsChanged(edits, a.edits)) {
      const moved = changedAlarms(a.alarms, (await previewAlarms(a.id, edits)).alarms);
      if (needsMoveConfirm(moved)) {
        setChanges(moved);
        return;
      }
    }
    await apply(undefined, choice);
  }

  // A saved AUTO schedule can be recomputed after the user's pure-prep
  // preference changes, even when none of the H03 form controls changed.
  // Never silently alter shared, legacy/manual or individually moved alarms.
  function recalculatePureAuto() {
    if (busy || dirty || a.groupName != null || a.prepareValueSource !== 'AUTO' ||
        edits.prepareMinutes != null || manualAny) return;
    void run(async () => {
      const next = await previewAlarms(a.id, edits);
      const moved = changedAlarms(a.alarms, next.alarms);
      if (needsMoveConfirm(moved)) {
        setChanges(moved);
        return;
      }
      await apply(); // alarm-commit recalculates AUTO inputs even if draft is unchanged
    }, '자동 알람을 다시 계산하지 못했어요');
  }

  // 확인 시트 "바꾸기" — 저장과 같은 잠금으로 연타를 막음
  function confirmApply() {
    void run(() => apply(), '저장하지 못했어요');
  }

  // 이동시간 확인 시트 "이 값으로 저장" — 보여 준 분을 예상 이동(직접 입력)으로 넣어 저장
  function confirmTravel() {
    if (!travelConfirm) return;
    const { minutes } = travelConfirm;
    void run(() => apply(minutes), '저장하지 못했어요');
  }

  // "예상 이동을 직접 고칠게요" · 바깥 누름 — 저장하지 않고 닫음. 예상 이동 칸에는 미리 보기의 같은 값이 보여서 거기서 고치면 됨
  function editTravel() {
    if (busy) return;
    setTravelConfirm(null);
    setWakeChoice(undefined); // 이번 저장은 끝남 — 다시 저장하면 합치기도 다시 물음
  }

  // 시트 "그대로 두기" · 바깥 누름 — 알람 시각을 밀어 움직이는 입력만 되돌림 (D34). 직접 고른 알람 시각은 그대로
  function keep() {
    if (busy) return; // "바꾸기"가 저장하는 중이면 그대로 두기 · 시트 닫기도 기다림
    const { bufferMinutes, origin, transport, travelMinutes, prepareMinutes } = a.edits;
    setEdit({ bufferMinutes, origin, transport, travelMinutes, prepareMinutes });
    setChanges(null);
    setWakeChoice(undefined); // 저장을 그만둠 — 고른 합치기를 다음 저장에 쓰지 않음
  }

  // 저장은 화면 아래에 고정 — 폼이 길어 스크롤 끝까지 내려가지 않아도 보이게. 바뀐 게 없거나 순서가 뒤집혔으면 못 누름
  const footer = <Button label="저장" onPress={save} disabled={!dirty || blocked != null} loading={busy && changes == null && travelConfirm == null} />;

  function confirmPhysicalStart() {
    if (!pilot || startAlreadyReported || !canReportNow || prepStartReport?.departed_at || busy) return;
    void run(async () => {
      const timestamp = await confirmPrepStartSelfReport(a.id);
      setReportedAt(timestamp);
      await reloadPrepStartReport();
      toast('준비 시작 확인 시각을 기록했어요');
    }, '준비 시작 시각을 기록하지 못했어요');
  }

  // 일정을 지운 5초 — 되돌리기 토스트가 떠 있는 동안 지운 일정만 보임 (5초 뒤 · 화면을 떠날 때 실제로 지움)
  if (edit.deleted) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H03" />
        <EmptyState title="일정을 지웠어요" body="5초 안에 되돌릴 수 있어요" action={{ label: '되돌리기', onPress: edit.undoDelete }} />
      </Screen>
    );
  }

  return (
    <Screen footer={showAlarms ? footer : undefined}>
      <TopBar onBack={backOrHome} screenId="H03" />
      <Text variant="title" style={styles.title}>
        알람 설정
      </Text>
      <Text variant="lead" style={styles.lead}>
        {formatDateShort(a.at)} ·{' '}
        <Text variant="lead" tone="ink">
          {first ? `${formatTime(first.at)} ${KIND_LABEL[first.kind]}` : '알람 없음'}
        </Text>
      </Text>

      <Card onPress={edit.open} accessibilityLabel={`연결 일정 ${a.title}, 눌러서 고치기`}>
        <Text variant="label" tone="sub" style={styles.label}>
          연결 일정
        </Text>
        <View style={styles.between}>
          <Text variant="big">{a.title}</Text>
          <View style={styles.tail}>
            <Chip label={IMPORTANCE_LABEL[a.importance]} variant="fill" />
            <Text variant="bodyStrong" tone="faint">
              ›
            </Text>
          </View>
        </View>
        <Text variant="small" tone="sub" style={styles.sub}>
          {formatTime(a.at)} · {a.place || PLACE_PENDING_LABEL} · {a.repeatLabel}
        </Text>
      </Card>

      {pilot ? (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            준비 시작 시각 확인 · 연구용
          </Text>
          <Text variant="body" tone="sub">
            실제로 외출 준비를 시작하는 순간 눌러 주세요. 준비 알람을 끈 시각과 별도로 저장하며, 알람 시간은 바뀌지 않아요.
          </Text>
          {startAlreadyReported ? (
            <Text variant="bodyStrong">내가 확인한 준비 시작: {formatTime(new Date(startAlreadyReported))}</Text>
          ) : (
            <Button
              label="지금 실제 준비 시작했어요"
              variant="ghost"
              onPress={confirmPhysicalStart}
              disabled={!canReportNow || prepStartReport?.departed_at != null || prepStartReport === undefined}
              loading={busy}
            />
          )}
          {!canReportNow && !startAlreadyReported ? (
            <Text variant="caption" tone="sub">
              약속 3시간 전부터 약속 1시간 후까지만 기록할 수 있어요.
            </Text>
          ) : null}
          <Text variant="caption" tone="sub">
            본인이 누른 시각은 자기 보고 자료예요. 별도의 연구·모델 학습 동의가 확인되기 전에는 학습에 사용하지 않아요.
          </Text>
        </Card>
      ) : null}

      {occurrences && occurrences.length > 1 ? (
        <OccurrenceList
          occurrences={occurrences}
          currentId={a.id}
          expanded={showAllOccurrences}
          onToggleExpanded={() => setShowAllOccurrences((v) => !v)}
        />
      ) : null}

      {showAlarms ? (
        <>
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            이동 조건
          </Text>
          <SelectRow first label="출발 위치" value={edits.origin} options={originOptions} onChange={(origin) => setEdit({ origin })} />
          <SelectRow<Transport> label="이동 수단" value={edits.transport} options={TRANSPORT_OPTIONS} onChange={(transport) => setEdit({ transport })} />
          <Stepper
            label="예상 이동"
            value={travel}
            onChange={(next) => setEdit({ travelMinutes: next === view.autoTravelMinutes ? null : next })}
            min={1}
            max={240}
            step={1}
            unit="분"
          />
          <View style={styles.axisDesc}>
            <Text variant="caption" tone="faint">
              {edits.travelMinutes != null ? MANUAL_SOURCE : view.travelSource}
            </Text>
            {edits.travelMinutes != null ? (
              <TextLink label="자동으로" accessibilityLabel="예상 이동 자동으로 되돌리기" onPress={() => setEdit({ travelMinutes: null })} />
            ) : (
              <View />
            )}
          </View>
          {/* 길찾기를 못 한 미리 보기 (실데이터) — 직접 입력한 값이 있으면 문제가 아님 */}
          {edits.travelMinutes == null && view.travelProblem ? (
            <Text variant="caption" tone="warn" style={styles.note} accessibilityLiveRegion="polite">
              {TRAVEL_PROBLEM_NOTE[view.travelProblem]}
            </Text>
          ) : null}
        </Card>

        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            준비 시간
          </Text>
          {a.beforePrepMinutes ? <KeyValueRow first label="준비 전 활동" value={`${a.beforePrepMinutes}분`} /> : null}
          <KeyValueRow first={!a.beforePrepMinutes} label="실제 준비" value={`${a.prepMinutes}분`} />
          {/* 실데이터는 실제 준비 = 예측 − 준비 전 활동이라 늘 0 → 더한 게 없으면 줄을 안 보임 */}
          {margin > 0 ? <KeyValueRow label="넉넉히 더한 시간" value={`+${margin}분`} sub="늦지 않도록 실제 준비에 더했어요" /> : null}
          <KeyValueRow label="예측 준비" value={`${a.auto.predictedPrepMinutes}분`} sub="내 기록이 쌓일수록 나에게 맞춰져요" />
          <Stepper
            label="준비 시간"
            value={prepare}
            onChange={(next) => setEdit({ prepareMinutes: next === view.autoPredictedPrepMinutes ? null : next })}
            min={Math.max(5, a.beforePrepMinutes)}
            max={240}
            step={1}
            unit="분"
          />
          {edits.prepareMinutes != null ? (
            <View style={styles.axisDesc}>
              <Text variant="caption" tone="faint">
                직접 고름 · 자동은 {view.autoPredictedPrepMinutes}분
              </Text>
              <TextLink label="자동으로" accessibilityLabel="준비 시간 자동으로 되돌리기" onPress={() => setEdit({ prepareMinutes: null })} />
            </View>
          ) : null}
          {a.groupName == null && a.prepareValueSource === 'AUTO' && edits.prepareMinutes == null && !manualAny ? (
            <Button
              label="최신 기본값으로 알람 다시 계산"
              onPress={recalculatePureAuto}
              disabled={busy || dirty}
              loading={busy}
            />
          ) : null}
          <Stepper
            label="여유 시간"
            value={edits.bufferMinutes}
            onChange={(bufferMinutes) => setEdit({ bufferMinutes })}
            min={0}
            max={30}
            step={1}
            unit="분"
          />
        </Card>

        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            알람 시각
          </Text>
          <FormulaBox
            lines={[
              `${KIND_LABEL[baseKind]} ${formatTime(base)} = 약속 ${formatTime(a.at)} − 여유 ${edits.bufferMinutes} − 이동 ${travel} − 준비 ${prepare}`,
              ...(followsWake && a.beforePrepMinutes ? [`준비 알람은 기상 후 준비 전 활동 ${a.beforePrepMinutes}분 뒤`] : []),
              // 준비 시간이 어디서 왔는지 한 줄 — 4건까지 "배우는 중 N/5", 5건부터 "내 기록 기반 N건" (학습 루프 기초 ⑦, 통계 식은 안 보임 D47)
              //   기록으로 맞추는 건 그날 첫 일정(기상 있음)뿐이고, 직접 고른 준비 시간이면 기록 기반이 아니라서 줄을 뺌. 서버가 기록 수를 주기 전(처음 그릴 때)에도 뺌
              ...(followsWake && edits.prepareMinutes == null && view.prepareSampleCount != null ? [`준비 ${prepare}분 · ${prepareSourceLabel(view.prepareSampleCount)}`] : []),
              // 그 아래 한 줄 — 최근 기록 값 (학습 루프 기초 ⑦). 위 줄과 같은 조건이고, 기록이 없으면 줄이 없음
              ...(followsWake && edits.prepareMinutes == null && recentLine ? [recentLine] : []),
            ]}
          />
          {/* 자동으로 기상이 안 생긴 일정(그날 앞 일정에 기상 · 낮 12시 이후 기상)도 기상 줄은 꺼짐으로 보이고, 켜면 시각을 골라 직접 만듦 (#624) */}
          {missingWake ? (
            <KeyValueRow
              first
              label={KIND_LABEL.WAKE}
              sub="미설정"
              value={<Toggle value={false} onChange={(on) => on && setPickKind('WAKE')} label={`${KIND_LABEL.WAKE} 알람`} />}
            />
          ) : null}
          {view.alarms.map((x, i) => (
            <KeyValueRow
              key={x.kind}
              first={i === 0 && !missingWake}
              label={`${KIND_LABEL[x.kind]}${x.kind === 'ARRIVE' ? ' 목표' : ''}`}
              sub={isManualTime(x) ? '직접 고름' : undefined}
              value={
                x.kind === 'ARRIVE' ? (
                  formatTime(x.at)
                ) : (
                  <View style={styles.timeRow}>
                    <TimeButton
                      label={formatTime(x.at)}
                      manual={isManualTime(x)}
                      accessibilityLabel={`${KIND_LABEL[x.kind]} 시각 ${formatTime(x.at)}, 눌러서 고르기`}
                      onPress={() => setPickKind(x.kind as RingKind)}
                    />
                    <Toggle value={kinds[x.kind] ?? x.enabled} onChange={(on) => setKinds((k) => ({ ...k, [x.kind]: on }))} label={`${KIND_LABEL[x.kind]} 알람`} />
                  </View>
                )
              }
            />
          ))}
          {/* 웹은 폰 알람이 울리지 않아 저장된 알람으로 울림 화면을 미리 봄 — 끄면 다음 알람으로 이어짐 (ringPreview.ts) */}
          {Platform.OS === 'web' ? (
            <View style={styles.previewRow}>
              <Text variant="caption" tone="faint">
                웹 미리보기
              </Text>
              {a.alarms
                .filter((x) => x.kind !== 'ARRIVE' && x.enabled)
                .map((x) => (
                  <TextLink
                    key={x.kind}
                    label={`${KIND_LABEL[x.kind]} 울려 보기`}
                    onPress={() => router.push({ pathname: '/ring', params: { alarm: previewAlarmId(a.id, x.kind as RingKind) } })}
                  />
                ))}
            </View>
          ) : null}
          {blocked ? (
            <Text variant="caption" tone="warn" style={styles.note} accessibilityLiveRegion="polite">
              {blocked}
            </Text>
          ) : null}
          <Text variant="caption" tone="faint" style={styles.note}>
            직접 고른 시각은 자동 계산보다 먼저 적용되고, 기상을 옮기면 준비도 같은 만큼 옮겨져요.
          </Text>
          {manualAny ? (
            <View style={styles.reset}>
              <TextLink label="모두 자동으로 되돌리기" onPress={() => setEdit({ times: {} })} />
            </View>
          ) : null}
        </Card>

        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            알람 강도
          </Text>
          {/* 점수 식은 안 보임 — 결과와 쉬운 말만 (H05 계산 근거와 같게, D47) */}
          <Text variant="small" tone="sub">
            자동 {LEVELS[a.intensity.auto].name} · 중요도 {IMPORTANCE_LABEL[a.importance]}
            {a.intensity.latePoint > 0 ? ` · 최근 4주 늦잠 지각 ${a.intensity.lateCount}번` : ''}
          </Text>
          {/* 축별 선택(배경음 · 말소리 · 진동)은 flag로 숨길 수 있음 — 결정 안건(투표) 결과 대기 (lib/flags.ts ALARM_AXES_PICKER) */}
          {(ALARM_AXES_PICKER ? AXES : []).map(([axis, name]) => {
            const picked = levels[axis];
            const level = picked ?? (axis === 'voice' ? a.intensity.voiceAuto : a.intensity.auto); // 말소리 자동 = 설정의 기본 말소리
            return (
              <View key={axis}>
                <View style={styles.axis}>
                  <View style={styles.axisName}>
                    <Text variant="rowLabel" tone="sub">
                      {name}
                    </Text>
                    {picked != null ? (
                      <Text variant="tiny" tone="sub" style={styles.manual}>
                        직접 고름
                      </Text>
                    ) : null}
                  </View>
                  <OptionGrid
                    size="mini"
                    label={`${name} 강도`}
                    options={LEVEL_OPTIONS}
                    value={level}
                    onChange={(next) => setLevels((l) => ({ ...l, [axis]: next }))}
                  />
                </View>
                <View style={styles.axisDesc}>
                  {/* 직접 고른 항목만 이 축을 자동으로 되돌리는 링크 */}
                  {picked != null ? (
                    <TextLink
                      label="자동으로"
                      accessibilityLabel={`${name} 자동으로 되돌리기`}
                      onPress={() => setLevels((l) => ({ ...l, [axis]: null }))}
                    />
                  ) : (
                    <View />
                  )}
                  <Text variant="label" tone="faint" align="right" accessibilityLiveRegion="polite">
                    {LEVELS[level][axis]}
                  </Text>
                </View>
              </View>
            );
          })}
          {ALARM_AXES_PICKER ? (
            <Text variant="caption" tone="faint" style={styles.note}>
              직접 고른 항목은 자동 계산보다 항상 먼저 적용돼요.
            </Text>
          ) : null}
          {ALARM_AXES_PICKER && anyManual ? (
            <View style={styles.reset}>
              <TextLink label="모두 자동으로 되돌리기" onPress={() => setLevels({ sound: null, voice: null, vibration: null })} />
            </View>
          ) : null}
        </Card>
        </>
      ) : (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            알람
          </Text>
          <Text variant="body" tone="sub">
            {placePending
              ? '장소가 정해지지 않아 알람을 계산하지 않았어요. 위의 연결 일정을 눌러 장소를 정해 주세요.'
              : '아직 알람이 없는 일정이에요. 기상 · 준비 · 출발 알람을 계산해 보고 확인한 뒤 저장할 수 있어요.'}
          </Text>
          {placePending ? null : (
            <View style={styles.stack}>
              <Button label="알람 계산해 보기" variant="ghost" onPress={() => setShowAlarms(true)} />
            </View>
          )}
        </Card>
      )}

      {/* 알람 시각 직접 고르기 — 기상을 옮기면 준비도 같은 간격으로 따라옴 */}
      <TimeSheet
        visible={picking != null}
        onClose={() => setPickKind(null)}
        title={pickKind ? `${KIND_LABEL[pickKind]} 시각` : ''}
        value={picking?.at ?? (pickKind === 'WAKE' ? first?.at : undefined) ?? a.at}
        // 없던 기상을 새로 만들면 기상 시각만 보냄 — 서버가 기상은 따로 두고 준비 · 출발은 일정 기준으로 계산 (준비를 고정하지 않아 일정 시각이 바뀌면 다시 계산됨)
        onChange={(to) => pickKind && setEdit({ times: pickKind === 'WAKE' && missingWake ? { ...edits.times, WAKE: to } : manualTimes(moveAlarm(view.alarms, pickKind, to)) })}
        autoAt={picking && isManualTime(picking) ? picking.auto : undefined}
        onReset={() => pickKind && setEdit({ times: manualTimes(resetAlarm(view.alarms, pickKind)) })}
        // 준비가 기상을 따라가는 일정만 (따로 울리는 기상 · 미설정 기상은 준비가 그대로)
        note={pickKind === 'WAKE' && followsWake && !missingWake && view.alarms.some((x) => x.kind === 'PREPARE') ? '준비 알람도 같은 만큼 같이 움직여요' : undefined}
        error={blocked ?? undefined}
      />

      {/* 같은 날 직접 만든 기상 알람이 있으면 — 이 일정 기상으로 합칠지(그 알람은 지워짐) 따로 둘지(둘 다 울림) 고름. 바깥 누름은 저장하지 않고 닫음 */}
      <Sheet visible={wakeDup != null} onClose={closeWakeDup} title="같은 날 기상 알람이 있어요">
        <Text variant="small" tone="sub">
          직접 만든 기상 알람이 있어요. 이 일정의 기상 알람으로 합치면 그 시각에 한 번만 울리고, 따로 두면 둘 다 울려요.
        </Text>
        <View style={styles.changes}>
          {(wakeDup ?? []).map((w) => (
            <View key={w.id} style={styles.change}>
              <Text variant="body" tone="sub">
                직접 만든 기상
              </Text>
              <Text variant="bodyStrong">{formatTime(w.at)}</Text>
            </View>
          ))}
          {view.alarms
            .filter((x) => x.kind === 'WAKE')
            .map((x) => (
              <View key={x.kind} style={styles.change}>
                <Text variant="body" tone="sub">
                  이 일정의 기상 (계산)
                </Text>
                <Text variant="bodyStrong">{formatTime(x.at)}</Text>
              </View>
            ))}
        </View>
        <View style={styles.stack}>
          {(wakeDup ?? []).map((w) => (
            <Button key={w.id} label={`${formatTime(w.at)} 알람을 이 일정 기상으로 합치기`} onPress={() => pickWake(w)} loading={busy} />
          ))}
          <Button label="따로 두기 (둘 다 울림)" variant="ghost" onPress={() => pickWake(null)} />
        </View>
      </Sheet>

      {/* 길찾기를 못 해 어림값만 있을 때 — 사용자가 확인한 값만 직접 입력(MANUAL)으로 저장 (7장 7.1.2) */}
      <Sheet visible={travelConfirm != null} onClose={editTravel} title="이동시간을 확인해 주세요">
        <Text variant="small" tone="sub">
          {travelConfirm ? travelConfirmMessage(travelConfirm) : ''}
        </Text>
        <View style={styles.stack}>
          <Button label={TRAVEL_CONFIRM_OK} onPress={confirmTravel} loading={busy} />
          <Button label={TRAVEL_CONFIRM_EDIT} variant="ghost" onPress={editTravel} />
        </View>
      </Sheet>

      {/* 일정 편집 시트 (U14) — 날짜 · 시간 · 장소 · 반복 범위 시트는 편집 시트 대신 하나씩 뜸 (시트는 한 번에 하나) */}
      <ScheduleEditSheet
        visible={edit.step === 'edit'}
        onClose={edit.close}
        initial={edit.initial}
        value={edit.value}
        onChange={edit.change}
        onPickPlace={edit.pickPlace}
        onPickDate={edit.pickDate}
        onPickTime={edit.pickTime}
        onSave={edit.save}
        onDelete={edit.startDelete}
        saving={edit.saving}
        onLeave={edit.shared ? edit.leave : undefined}
      />
      <DateSheet visible={edit.step === 'date'} onClose={edit.back} title="날짜" value={edit.value.at} onChange={(at) => edit.change({ at })} minDate={startOfDay(now())} />
      <TimeSheet
        visible={edit.step === 'time'}
        onClose={edit.back}
        title="시간"
        value={edit.value.at}
        onChange={(at) => edit.change({ at })}
        error={edit.value.at.getTime() !== edit.initial.at.getTime() && edit.value.at.getTime() <= now().getTime() ? '이미 지난 시각이에요' : undefined}
      />
      <PlaceSearchSheet
        visible={edit.step === 'place'}
        onClose={edit.back}
        search={edit.searchPlaces}
        onPick={(picked) => {
          edit.change({ place: picked.name, placeLat: picked.lat, placeLng: picked.lng });
          edit.back();
        }}
      />
      <RepeatScopeSheet
        visible={edit.step === 'scopeSave' || edit.step === 'scopeDelete'}
        onClose={edit.back}
        title={edit.step === 'scopeDelete' ? '어느 일정을 지울까요?' : '어느 일정을 바꿀까요?'}
        onPick={edit.step === 'scopeDelete' ? edit.pickDeleteScope : edit.pickSaveScope}
      />

      {/* 알람 시각이 바뀌는 저장이면 바뀌는 알람을 전부 보여 주고 한 번 더 물음 — 설정 저장 · 일정 편집 저장이 같은 시트를 씀 */}
      <Sheet visible={changes != null || edit.step === 'move'} onClose={edit.step === 'move' ? edit.cancelMove : keep} title="알람 시각이 바뀌어요">
        <Text variant="small" tone="sub">
          저장하면 아래 알람이 이렇게 바뀌어요.
        </Text>
        <View style={styles.changes}>
          {(changes ?? edit.move?.changes ?? []).map((c) => (
            <View key={c.kind} style={styles.change}>
              <Text variant="body" tone="sub">
                {KIND_LABEL[c.kind]}
              </Text>
              <Text variant="bodyStrong">
                {formatTime(c.from)} → {formatTime(c.to)}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.stack}>
          <Button label="바꾸기" onPress={edit.step === 'move' ? edit.confirmMove : confirmApply} loading={busy || edit.saving} />
          <Button label="그대로 두기" variant="ghost" onPress={edit.step === 'move' ? edit.cancelMove : keep} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sub: { marginTop: 4 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  previewRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 10 },
  axis: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12 },
  axisName: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 6 },
  manual: { backgroundColor: colors.chip, borderRadius: 8, paddingHorizontal: 6, overflow: 'hidden' },
  axisDesc: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  note: { marginTop: 10 },
  reset: { marginTop: 6, alignSelf: 'flex-start' },
  stack: { gap: 10, marginTop: 16 },
  changes: { marginTop: 12 },
  change: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
});
