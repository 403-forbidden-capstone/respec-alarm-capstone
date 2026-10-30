import { prepareSourceLabel } from '@shared/calc/prepare.ts';
import { router, useLocalSearchParams } from 'expo-router';
import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, DateRow, Field, KeyValueRow, LoadError, Screen, Sheet, Text, toast, Toggle, TopBar } from '@/components/ui';
import { createAppointment, defaultDraft, draftAt, estimateAppointment, listAppointments, listPlaces } from '@/features/alarm/api';
import { adjustEstimate, isManualTime, orderError } from '@/features/alarm/adjust';
import { useNow } from '@/features/alarm/hooks/useNow';
import { ItemChips } from '@/features/alarm/components/ItemChips';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { RepeatPicker } from '@/features/alarm/components/RepeatPicker';
import { SelectRow } from '@/features/alarm/components/SelectRow';
import { TimeButton } from '@/features/alarm/components/TimeButton';
import { TimePickBody } from '@/features/alarm/components/TimePicker';
import { TimeRow } from '@/features/alarm/components/TimeRow';
import { homeOf } from '@/features/alarm/placeSheet';
import { repeatToRrule } from '@/features/alarm/repeat';
import { addItems, earlierWakeOf, isPassed, parseDayParam, ringingKinds, tomorrow, upcomingAlarms } from '@/features/alarm/schedule';
import {
  IMPORTANCE_LABEL,
  KIND_LABEL,
  LEVELS,
  RING_KINDS,
  TRANSPORT_LABEL,
  TRANSPORT_OPTIONS,
  type Estimate,
  type Importance,
  type RingKind,
  type Transport,
} from '@/features/alarm/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { foundScheduleDraft, saveFoundSchedule } from '@/features/voice/api';
import { now } from '@/lib/clock';
import { addMinutes, dayKey, formatDateShort, formatTime, formatTime24, startOfDay } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const IMPORTANCE_OPTIONS = (['LOW', 'NORMAL', 'HIGH'] as const).map((v) => [v, IMPORTANCE_LABEL[v]] as const);

type EarlierWake = { title: string; at: Date }; // 같은 날 앞 일정의 기상 알람 (schedule.ts earlierWakeOf)

// 기상 알람이 안 생기는 이유 한 줄 — 같은 날 앞 일정의 기상 알람으로 깨우기 때문 (api.ts hasEarlierWake)
const wakeNote = (w: EarlierWake) => `같은 날 ${w.title} 기상 알람(${formatTime(w.at)})으로 깨워요`;

// H05 새 일정 만들기 — 입력하면 이동시간 · 준비 시간으로 알람을 계산해 확인 시트로 보여 줌
// from=chat: AI 대화(A02)에서 찾은 일정을 "수정"으로 연 것 — 찾은 값으로 채우고, 저장하면 대화로 돌아감
// from=home · from=alarms: 저장하면 온 화면으로 돌아감 (알람 목록이면 새 일정에 테두리), date=2025-05-22: 처음 날짜 (홈이 보여 주는 날)
export default function NewScheduleScreen() {
  const params = useLocalSearchParams<{ from?: string; date?: string }>();
  const from = params.from;
  // 대화에서 왔고 찾은 일정이 아직 대기일 때만 — 이미 확인한 카드면 보통 새 일정으로 (두 벌 저장 막기)
  const [fromChat] = useState(() => from === 'chat' && foundScheduleDraft() != null);
  const { data: places, error: placesError, reload: reloadPlaces } = useLoad(listPlaces);
  const { data: appointments } = useLoad(listAppointments); // 같은 날 앞 일정의 기상 알람을 찾는 데만 씀 — 못 읽어도 폼은 그대로
  const [initial] = useState(() => {
    if (fromChat) {
      const found = foundScheduleDraft();
      if (found) return found;
    }
    // 지난 날짜가 넘어오면 내일로
    const day = parseDayParam(params.date);
    return defaultDraft(day && dayKey(day) >= dayKey(now()) ? day : tomorrow(now()));
  });
  const [edited, setDraft] = useState(initial);
  // 실데이터는 장소를 골라야(최근 장소 · 검색 시트) 해서 처음 값이 비어 있음 — 아직 안 골랐으면 최근 장소의 첫 곳을 미리 골라 둔 것으로 보여 줌 (처음 값 그대로라 나갈 때 묻지 않음). 가짜 데이터는 처음부터 있음
  const preset = edited.place === '' ? places?.[0] : undefined;
  const draft = preset ? { ...edited, place: preset.name, placeLat: preset.lat, placeLng: preset.lng } : edited;
  const [itemList, setItemList] = useState(() => addItems([], initial.items));
  const [itemText, setItemText] = useState('');
  const [titleError, setTitleError] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [pick, setPick] = useState<RingKind | null>(null); // 확인 시트에서 시각을 고르는 알람 (D43)
  const [placeOpen, setPlaceOpen] = useState(false); // 장소 검색 시트
  const home = homeOf(useAuth().profile); // 프로필의 집 좌표 — 있으면 검색 결과를 집에서 가까운 순으로 (가짜 데이터의 가짜 프로필은 좌표가 없음)
  const [showCalc, setShowCalc] = useState(false); // 계산 근거 "자세히"를 펼침
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
    repeatToRrule(draft.repeat) !== repeatToRrule(initial.repeat) ||
    edited.place !== initial.place ||
    draft.transport !== initial.transport ||
    draft.importance !== initial.importance ||
    RING_KINDS.some((kind) => draft.alarms[kind] !== initial.alarms[kind]);
  const { allowLeave } = useLeaveGuard(dirty, '입력한 일정이 사라져요.');

  const at = draftAt(draft.date, draft.time);
  const past = at.getTime() <= current.getTime();
  const anyAlarm = RING_KINDS.some((kind) => draft.alarms[kind]); // 모두 끄면 알람 없는 일정 (D46)
  // 같은 날 앞 일정에 켜진 기상 알람이 있으면 이 일정은 기상 알람 없이 준비부터 — 스위치 아래 · 확인 시트에 그 이유를 한 줄로
  const earlierWake = appointments ? earlierWakeOf(at, appointments) : null;

  // 확인 시트 닫기 · 닫고 수정하기 — 시트에서 고친 시각은 버림 (다시 계산하면 자동 값부터)
  function closeSheet() {
    setEstimate(null);
    setPick(null);
  }

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
      setShowCalc(false);
      setPick(null);
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
        !saved.alarms.length
          ? '일정을 알람 없이 저장했어요'
          : rings
            ? `알람 ${rings}개를 맞췄어요${skipped ? ` · 지난 알람 ${skipped}개는 울리지 않아요` : ''}`
            : '일정을 저장했어요 · 울릴 알람이 없어요',
      );
      closeSheet();
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
        <RepeatPicker value={draft.repeat} onChange={(next) => set('repeat', next)} />
      </Card>

      {/* 처음 장소 목록(최근 장소)을 못 읽었으면 이유 + 다시 시도 — 장소 검색 시트로는 그래도 고를 수 있음 */}
      {!places && placesError ? <LoadError onRetry={reloadPlaces} /> : null}
      <Card>
        <Text variant="label" tone="sub">
          장소와 중요도
        </Text>
        {/* SelectRow와 같은 모양 — 누르면 목록 대신 검색 시트. 실데이터는 고른 장소의 좌표도 초안에 담아 계산 · 저장 요청까지 가져감 (가짜 데이터는 좌표가 없음) */}
        <Pressable
          onPress={() => setPlaceOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`장소 ${draft.place || '고르기'}`}
          style={({ pressed }) => [styles.placeRow, pressed && styles.pressed]}
        >
          <Text variant="rowLabel" tone="sub">
            장소
          </Text>
          <View style={styles.placeValue}>
            <Text variant="bodyStrong" tone={draft.place ? 'ink' : 'faint'} numberOfLines={1} style={styles.placeName}>
              {draft.place || '장소 고르기'}
            </Text>
            <Text variant="bodyStrong" tone="faint">
              ›
            </Text>
          </View>
        </Pressable>
        <PlaceSearchSheet
          visible={placeOpen}
          onClose={() => setPlaceOpen(false)}
          search={(query) => listPlaces(query, home)}
          onPick={(picked) => {
            setDraft((d) => ({ ...d, place: picked.name, placeLat: picked.lat, placeLng: picked.lng }));
            setPlaceOpen(false);
          }}
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

      <Card>
        <Text variant="label" tone="sub" style={styles.cardLabel}>
          알람
        </Text>
        {RING_KINDS.map((kind, i) => (
          <Fragment key={kind}>
            <KeyValueRow
              first={i === 0}
              label={`${KIND_LABEL[kind]} 알람`}
              value={
                <Toggle
                  value={draft.alarms[kind]}
                  onChange={(on) => set('alarms', { ...draft.alarms, [kind]: on })}
                  label={`${KIND_LABEL[kind]} 알람`}
                />
              }
            />
            {kind === 'WAKE' && earlierWake ? (
              <Text variant="caption" tone="faint" align="right" style={styles.wakeNote}>
                {wakeNote(earlierWake)}
              </Text>
            ) : null}
          </Fragment>
        ))}
        <Text variant="caption" tone="faint" style={styles.alarmNote}>
          모두 끄면 알람 없이 일정만 저장해요.
        </Text>
      </Card>

      <View style={styles.stack}>
        <Button label={anyAlarm ? '알람 계산하기' : '일정만 저장하기'} onPress={calculate} loading={calculating} disabled={past} />
      </View>

      {/* 확인 시트 — 알람 시각 칩을 누르면 같은 시트 안에서 시각을 고름 (시트는 한 번에 하나만 뜸), 계산 근거는 "자세히"로 접음 (D43) */}
      <Sheet
        visible={estimate != null}
        onClose={pick ? () => setPick(null) : closeSheet}
        title={pick ? `${KIND_LABEL[pick]} 시각` : estimate && !estimate.appointment.alarms.length ? '일정을 이렇게 저장할게요' : '알람을 이렇게 맞출게요'}
      >
        {estimate && pick ? (
          <PickStep
            key={pick}
            estimate={estimate}
            kind={pick}
            onChange={(to) => setEstimate((e) => e && adjustEstimate(e, pick, to))}
            onDone={() => setPick(null)}
          />
        ) : estimate ? (
          <CalcSteps
            estimate={estimate}
            current={current}
            earlierWake={appointments ? earlierWakeOf(estimate.appointment.at, appointments) : null}
            saving={saving}
            showCalc={showCalc}
            onToggleCalc={() => setShowCalc((v) => !v)}
            onPick={setPick}
            onSave={save}
            onEdit={closeSheet}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

// 알람 시각 하나 고르기 — 직접 고르면 "직접 고름"으로 표시하고 자동 계산보다 먼저 씀, 기상을 옮기면 준비도 같은 간격으로 (adjust.ts)
function PickStep({ estimate, kind, onChange, onDone }: { estimate: Estimate; kind: RingKind; onChange: (to: Date | null) => void; onDone: () => void }) {
  const alarms = estimate.appointment.alarms;
  const target = alarms.find((x) => x.kind === kind);
  if (!target) return null;
  return (
    <TimePickBody
      value={target.at}
      onChange={onChange}
      onDone={onDone}
      autoAt={isManualTime(target) ? target.auto : undefined}
      onReset={() => onChange(null)}
      note={kind === 'WAKE' && alarms.some((x) => x.kind === 'PREPARE') ? '준비 알람도 같은 만큼 같이 움직여요' : undefined}
      error={orderError(alarms) ?? undefined}
    />
  );
}

// 계산 순서 (.calc) — 이동 → 준비 → 알람 시각 → 강도. 알람 시각 칩은 눌러서 고침 (D43)
// 통계 식(P80 · 가중치 · 점수)은 사용자에게 안 보임 — 결과와 쉬운 말만 (#220, D47)
function CalcSteps({
  estimate: e,
  current,
  earlierWake,
  saving,
  showCalc,
  onToggleCalc,
  onPick,
  onSave,
  onEdit,
}: {
  estimate: Estimate;
  current: Date;
  earlierWake: EarlierWake | null; // 기상 칩이 빠진 이유에 넣을 앞 일정 (목록을 못 읽었으면 null — 이유는 일반 문구로)
  saving: boolean;
  showCalc: boolean;
  onToggleCalc: () => void;
  onPick: (kind: RingKind) => void;
  onSave: () => void;
  onEdit: () => void;
}) {
  const a = e.appointment;
  const arrive = a.alarms.find((x) => x.kind === 'ARRIVE');
  const rings = ringingKinds(a.alarms);
  const alarmless = rings.length === 0; // 알람을 모두 끄고 저장하는 일정 (D46)
  const anyPassed = rings.some((x) => isPassed(x, current));
  const blocked = orderError(a.alarms); // 순서가 뒤집히면 저장을 막음
  // 계산의 기준 시각 — 그날 첫 일정이면 기상, 아니면 준비. 그 알람을 안 만들어도, 시각을 직접 골라도 계산식은 자동 계산 그대로
  const baseKind = a.withWake ? 'WAKE' : 'PREPARE';
  const base = addMinutes(a.at, -(a.bufferMinutes + a.travelMinutes + a.predictedPrepMinutes));
  const steps: [string, string][] = [
    [`이동시간 ${a.travelMinutes}분`, e.travelNote ? `${e.travelNote} · ${TRANSPORT_LABEL[a.transport]}` : `카카오 길찾기 · ${TRANSPORT_LABEL[a.transport]} 최소 소요시간`],
    [
      `준비시간 ${a.predictedPrepMinutes}분`,
      // 기록으로 맞추는 건 그날 첫 일정(기상부터)뿐 — 두 번째 일정은 기록 줄 없이 공통 15분. 5건부터 "내 기록 기반 N건", 4건까지 "배우는 중 N/5" (학습 루프 기초 ⑦)
      e.sameDayWake ? '같은 날 기상 알람이 있어 외출 준비만' : `기상부터 출발까지 · ${prepareSourceLabel(e.sampleCount)}`,
    ],
    [
      `${KIND_LABEL[baseKind]} ${formatTime(base)}`,
      `${formatTime(a.at)} − 여유 ${a.bufferMinutes} − 이동 ${a.travelMinutes} − 준비 ${a.predictedPrepMinutes}`,
    ],
    [`알람 강도 ${LEVELS[a.level].name}`, `중요도 ${IMPORTANCE_LABEL[a.importance]}${e.latePoint > 0 ? ' · 최근 4주 늦잠 지각 2번 이상' : ''}`],
  ];

  return (
    <>
      <Text variant="small" tone="sub">
        {a.title} · {formatDateShort(a.at)} {formatTime(a.at)} · {a.place}
      </Text>
      {alarmless ? (
        <Text variant="note" tone="sub" style={styles.passedNote}>
          알람 없이 일정만 저장해요.
        </Text>
      ) : (
        <>
          {/* 울리는 알람만 칩으로 — 눌러서 시각을 고름. 도착 목표는 알람이 아니라 아래 한 줄. 이미 지난 알람은 지남 */}
          <View style={styles.chips}>
            {rings.map((x) => {
              const text = `${KIND_LABEL[x.kind]} ${formatTime(x.at)}${isManualTime(x) ? ' · 직접 고름' : ''}${isPassed(x, current) ? ' · 지남' : ''}`;
              return (
                <TimeButton
                  key={x.kind}
                  label={text}
                  manual={isManualTime(x)}
                  accessibilityLabel={`${text}, 눌러서 시각 고르기`}
                  onPress={() => onPick(x.kind as RingKind)}
                />
              );
            })}
          </View>
          {/* 기상 칩이 없는 이유 — 같은 날 앞 일정의 기상 알람으로 깨우기 때문 (오전 · 오후 일정이라서가 아님) */}
          {e.sameDayWake ? (
            <Text variant="caption" tone="faint" style={styles.passedNote}>
              {earlierWake ? wakeNote(earlierWake) : '같은 날 앞 일정의 기상 알람으로 깨워요'}
            </Text>
          ) : null}
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
          {/* 실데이터에서 길찾기를 못 해 직선거리로 어림한 이동시간이면 저장 전에 알림 — 저장하면 이 값을 확인한 것으로 보고 저장 */}
          {e.travelNeedsConfirm ? (
            <Text variant="label" tone="warn" style={styles.passedNote}>
              이동시간 {a.travelMinutes}분은 대략적인 값이에요. 저장하면 이 값으로 맞춰요
            </Text>
          ) : null}
          {blocked ? (
            <Text variant="label" tone="warn" style={styles.passedNote} accessibilityLiveRegion="polite">
              {blocked}
            </Text>
          ) : null}
          <Pressable
            onPress={onToggleCalc}
            accessibilityRole="button"
            accessibilityLabel={showCalc ? '계산 근거 접기' : '계산 근거 펼치기'}
            accessibilityState={{ expanded: showCalc }}
            style={({ pressed }) => [styles.calcToggle, pressed && styles.pressed]}
          >
            <Text variant="rowLabel" tone="sub">
              계산 근거 자세히
            </Text>
            <Text variant="rowLabel" tone="sub">
              {showCalc ? '접기 ⌃' : '펼치기 ⌄'}
            </Text>
          </Pressable>
          {showCalc ? (
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
          ) : null}
        </>
      )}
      {/* 아래 글자 버튼은 시트 머리의 "닫기"와 같은 일(시트를 닫고 폼으로) — 문구도 닫는다는 것이 보이게 */}
      <View style={styles.stack}>
        <Button label={alarmless ? '일정 저장' : '알람 저장'} onPress={onSave} loading={saving} disabled={blocked != null} />
        <Button label="닫고 수정하기" variant="plain" onPress={onEdit} disabled={saving} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  optLabel: { marginTop: 12, marginBottom: 8 },
  cardLabel: { marginBottom: 8 },
  alarmNote: { marginTop: 6 },
  wakeNote: { marginTop: -4, marginBottom: 8 },
  error: { marginTop: -4, marginBottom: 6 },
  stack: { gap: 10, marginTop: 16 },
  steps: { marginBottom: 4 },
  calcToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  pressed: { opacity: 0.6 },
  placeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  placeValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  placeName: { flexShrink: 1 },
  step: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1 },
  stepDetail: { marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  passedNote: { marginTop: 8 },
});
