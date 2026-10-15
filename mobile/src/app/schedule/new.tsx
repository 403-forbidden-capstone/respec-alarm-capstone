import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, DateRow, Field, LoadError, Screen, Sheet, Text, toast, TopBar } from '@/components/ui';
import { createAppointment, defaultDraft, draftAt, estimateAppointment, listPlaces } from '@/features/alarm/api';
import { useNow } from '@/features/alarm/hooks/useNow';
import { ItemChips } from '@/features/alarm/components/ItemChips';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { SelectRow } from '@/features/alarm/components/SelectRow';
import { TimeRow } from '@/features/alarm/components/TimeRow';
import { addItems, isPassed, parseDayParam, ringingKinds, tomorrow, upcomingAlarms } from '@/features/alarm/schedule';
import {
  IMPORTANCE_LABEL,
  IMPORTANCE_POINT,
  KIND_LABEL,
  LEVELS,
  TRANSPORT_LABEL,
  type Estimate,
  type Importance,
  type Transport,
} from '@/features/alarm/types';
import { foundScheduleDraft, saveFoundSchedule } from '@/features/voice/api';
import { now } from '@/lib/clock';
import { dayKey, formatDateShort, formatTime, formatTime24, startOfDay } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const REPEAT_OPTIONS = [
  ['NONE', '반복 없음'],
  ['WEEKLY', '매주 같은 요일'],
] as const;
const TRANSPORT_OPTIONS = (['TRANSIT', 'CAR', 'WALK'] as const).map((t) => [t, TRANSPORT_LABEL[t]] as const);
const IMPORTANCE_OPTIONS = (['LOW', 'NORMAL', 'HIGH'] as const).map((v) => [v, IMPORTANCE_LABEL[v]] as const);

// H05 새 일정 만들기 — 입력하면 이동시간 · 준비 시간으로 알람을 계산해 확인 시트로 보여 줌
// from=chat: AI 대화(A02)에서 찾은 일정을 "수정"으로 연 것 — 찾은 값으로 채우고, 저장하면 대화로 돌아감
// from=home · from=alarms: 저장하면 온 화면으로 돌아감 (알람 목록이면 새 일정에 테두리), date=2025-05-22: 처음 날짜 (홈이 보여 주는 날)
export default function NewScheduleScreen() {
  const params = useLocalSearchParams<{ from?: string; date?: string }>();
  const from = params.from;
  // 대화에서 왔고 찾은 일정이 아직 대기일 때만 — 이미 확인한 카드면 보통 새 일정으로 (두 벌 저장 막기)
  const [fromChat] = useState(() => from === 'chat' && foundScheduleDraft() != null);
  const { data: places, error: placesError, reload: reloadPlaces } = useLoad(listPlaces);
  const [initial] = useState(() => {
    if (fromChat) {
      const found = foundScheduleDraft();
      if (found) return found;
    }
    // 지난 날짜가 넘어오면 내일로
    const day = parseDayParam(params.date);
    return defaultDraft(day && dayKey(day) >= dayKey(now()) ? day : tomorrow(now()));
  });
  const [draft, setDraft] = useState(initial);
  const [itemList, setItemList] = useState(() => addItems([], initial.items));
  const [itemText, setItemText] = useState('');
  const [titleError, setTitleError] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const { busy: calculating, run: runCalculate } = useAction();
  const { busy: saving, run: runSave } = useAction();
  const current = useNow();
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // 뭔가 입력했으면 나갈 때 한 번 물음 (처음 값 그대로면 묻지 않음)
  const dirty =
    draft.title !== initial.title ||
    itemList.join(',') !== addItems([], initial.items).join(',') ||
    itemText.trim() !== '' ||
    dayKey(draft.date) !== dayKey(initial.date) ||
    draft.time !== initial.time ||
    draft.repeat !== initial.repeat ||
    draft.place !== initial.place ||
    draft.transport !== initial.transport ||
    draft.importance !== initial.importance;
  const { allowLeave } = useLeaveGuard(dirty, '입력한 일정이 사라져요.');

  const at = draftAt(draft.date, draft.time);
  const past = at.getTime() <= current.getTime();

  function calculate() {
    if (!draft.title.trim()) {
      setTitleError(true);
      return;
    }
    void runCalculate(async () => {
      const items = addItems(itemList, itemText); // 적어 두고 추가를 안 누른 준비물도 함께
      setItemList(items);
      setItemText('');
      setEstimate(await estimateAppointment({ ...draft, title: draft.title.trim(), items: items.join(',') }));
    }, '알람을 계산하지 못했어요');
  }

  // 저장한 뒤 온 곳으로 — 대화 · 홈은 그대로 돌아가고, 알람 목록(또는 모르는 곳)은 목록에서 새 일정에 테두리
  function leave(id: string) {
    if (fromChat && router.canGoBack()) router.back();
    else if (from === 'home') {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } else router.dismissTo({ pathname: '/alarms', params: { highlight: id } });
  }

  // 두 번 눌러도 일정이 한 번만 들어가게 저장 중에는 막음
  function save() {
    if (!estimate) return;
    void runSave(async () => {
      const saved = fromChat ? await saveFoundSchedule(estimate) : await createAppointment(estimate);
      const rings = upcomingAlarms(saved.alarms, now()).length;
      const skipped = ringingKinds(saved.alarms).filter((x) => isPassed(x, now())).length;
      toast(
        rings
          ? `알람 ${rings}개를 맞췄어요${skipped ? ` · 지난 알람 ${skipped}개는 울리지 않아요` : ''}`
          : '일정을 저장했어요 · 울릴 알람이 없어요',
      );
      setEstimate(null);
      allowLeave(); // 저장했으니 나가도 묻지 않음 — 나가는 동작보다 먼저
      leave(saved.id);
    }, '저장하지 못했어요');
  }

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="H05" />
      <Text variant="title" style={styles.title}>
        새 일정 만들기
      </Text>
      <Text variant="lead" style={styles.lead}>
        약속 정보를 바탕으로 필요한 알람을 계산해요.
      </Text>

      <Card>
        <Text variant="label" tone="sub">
          일정 정보
        </Text>
        <Field
          first
          label="일정명 *"
          accessibilityLabel="일정명 (필수)"
          value={draft.title}
          onChangeText={(v) => {
            set('title', v);
            if (v.trim()) setTitleError(false);
          }}
          placeholder="예: 스터디"
          maxLength={30}
        />
        {titleError ? (
          <Text variant="caption" tone="warn" align="right" style={styles.error} accessibilityLiveRegion="polite">
            일정명을 입력해 주세요
          </Text>
        ) : null}
        <DateRow label="날짜" value={draft.date} minDate={startOfDay(current)} onChange={(d) => set('date', startOfDay(d))} />
        <TimeRow
          label="시간"
          value={at}
          onChange={(next) => set('time', formatTime24(next))}
          error={past ? '이미 지난 시각이에요' : undefined}
        />
        <SelectRow label="반복" value={draft.repeat} options={REPEAT_OPTIONS} onChange={(v) => set('repeat', v)} />
      </Card>

      {/* 장소 목록을 못 읽으면 장소를 고를 수 없으니 이유 + 다시 시도 */}
      {!places && placesError ? <LoadError onRetry={reloadPlaces} /> : null}
      <Card>
        <Text variant="label" tone="sub">
          장소와 중요도
        </Text>
        <SelectRow
          first
          label="장소"
          value={draft.place}
          options={(places ?? []).map((p) => [p.name, p.name] as const)}
          onChange={(v) => set('place', v)}
        />
        <SelectRow<Transport>
          label="이동 수단"
          value={draft.transport}
          options={TRANSPORT_OPTIONS}
          onChange={(v) => set('transport', v)}
        />
        <Text variant="rowLabel" tone="sub" style={styles.optLabel}>
          중요도
        </Text>
        <OptionGrid<Importance>
          label="중요도"
          options={IMPORTANCE_OPTIONS}
          value={draft.importance}
          onChange={(v) => set('importance', v)}
        />
      </Card>

      <Card>
        <ItemChips
          label="준비물"
          placeholder="예: 노트북 충전기"
          items={itemList}
          onRemove={(name) => setItemList((list) => list.filter((x) => x !== name))}
          text={itemText}
          onChangeText={setItemText}
          onAdd={() => {
            setItemList((list) => addItems(list, itemText));
            setItemText('');
          }}
        />
      </Card>

      <View style={styles.stack}>
        <Button label="알람 계산하기" onPress={calculate} loading={calculating} disabled={past} />
      </View>

      <Sheet visible={estimate != null} onClose={() => setEstimate(null)} title="알람을 이렇게 맞출게요">
        {estimate ? <CalcSteps estimate={estimate} current={current} saving={saving} onSave={save} onEdit={() => setEstimate(null)} /> : null}
      </Sheet>
    </Screen>
  );
}

// 계산 순서 (.calc) — 이동 → 공통 P80 → 개인 보정 → 알람 시각 → 강도
function CalcSteps({
  estimate: e,
  current,
  saving,
  onSave,
  onEdit,
}: {
  estimate: Estimate;
  current: Date;
  saving: boolean;
  onSave: () => void;
  onEdit: () => void;
}) {
  const a = e.appointment;
  const first = a.alarms[0];
  const arrive = a.alarms.find((x) => x.kind === 'ARRIVE');
  const rings = ringingKinds(a.alarms);
  const anyPassed = rings.some((x) => isPassed(x, current));
  const steps: [string, string][] = [
    [`이동시간 ${a.travelMinutes}분`, `카카오 길찾기 · ${TRANSPORT_LABEL[a.transport]} 최소 소요시간`],
    [`공통 P80 ${e.commonP80}분`, `분위수 회귀 τ = 0.8 · ${e.sameDayWake ? '같은 날 기상 알람이 있어 외출 준비만' : '기상부터 출발까지'}`],
    [
      `개인 보정 +${e.correction}분`,
      `내 기록 ${e.sampleCount}건 · 가중치 ${e.sampleCount}÷(${e.sampleCount}+${e.prior}) = ${e.weight} × 개인 오차 P80 ${e.residualP80}분`,
    ],
    [
      `${KIND_LABEL[first.kind]} ${formatTime(first.at)}`,
      `${formatTime(a.at)} − 여유 ${a.bufferMinutes} − 이동 ${a.travelMinutes} − 준비 ${a.predictedPrepMinutes}`,
    ],
    [
      `알람 강도 ${LEVELS[a.level].name}`,
      `중요도 ${IMPORTANCE_LABEL[a.importance]} ${IMPORTANCE_POINT[a.importance]}점 + 최근 4주 늦잠 지각 ${e.latePoint}점`,
    ],
  ];

  return (
    <>
      <Text variant="small" tone="sub">
        {a.title} · {formatDateShort(a.at)} {formatTime(a.at)} · {a.place}
      </Text>
      <View style={styles.steps}>
        {steps.map(([head, detail], i) => (
          <View key={head} style={styles.step}>
            <View style={styles.num}>
              <Text variant="caption" tone="inverse" weight={600}>
                {i + 1}
              </Text>
            </View>
            <View style={styles.stepText}>
              <Text variant="bodyStrong">{head}</Text>
              <Text variant="label" tone="sub" style={styles.stepDetail}>
                {detail}
              </Text>
            </View>
          </View>
        ))}
      </View>
      {/* 울리는 알람만 칩으로 — 도착 목표는 알람이 아니라 아래 한 줄. 이미 지난 알람은 지남 */}
      <View style={styles.chips}>
        {rings.map((x) => (
          <Chip key={x.kind} label={`${KIND_LABEL[x.kind]} ${formatTime(x.at)}${isPassed(x, current) ? ' · 지남' : ''}`} variant="fill" />
        ))}
      </View>
      {anyPassed ? (
        <Text variant="label" tone="warn" style={styles.passedNote}>
          지난 알람은 울리지 않아요
        </Text>
      ) : null}
      {arrive ? (
        <Text variant="label" tone="sub" style={styles.passedNote}>
          도착 목표 {formatTime(arrive.at)}
        </Text>
      ) : null}
      <View style={styles.stack}>
        <Button label="알람 저장" onPress={onSave} loading={saving} />
        <Button label="돌아가서 수정" variant="plain" onPress={onEdit} disabled={saving} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  optLabel: { marginTop: 12, marginBottom: 8 },
  error: { marginTop: -4, marginBottom: 6 },
  stack: { gap: 10, marginTop: 16 },
  steps: { marginVertical: 14 },
  step: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1 },
  stepDetail: { marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  passedNote: { marginTop: 8 },
});
