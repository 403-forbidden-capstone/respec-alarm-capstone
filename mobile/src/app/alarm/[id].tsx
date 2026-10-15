import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, KeyValueRow, Loading, LoadError, Screen, Sheet, Stepper, Text, toast, Toggle, TopBar } from '@/components/ui';
import { getAppointment, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { TextLink } from '@/features/alarm/components/TextLink';
import { changedAlarms, ringingKinds, type AlarmChange } from '@/features/alarm/schedule';
import {
  AXES,
  IMPORTANCE_LABEL,
  KIND_LABEL,
  LEVELS,
  TRANSPORT_LABEL,
  type AlarmKind,
  type AlarmTime,
  type AppointmentDetail,
  type IntensityAxis,
  type Level,
} from '@/features/alarm/types';
import { formatDateShort, formatTime, minutesBetween } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLeaveGuard } from '@/lib/useLeaveGuard';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const LEVEL_OPTIONS = LEVELS.map((l, i) => [i as Level, l.name] as const);

type Levels = Record<IntensityAxis, Level | null>; // null = 자동

// H03 알람 설정 — 연결 일정 · 이동 조건 · 준비 시간 · 여유를 바꾸면 다시 계산 · 강도 직접 고르기
// 여유 · 종류별 켜기 · 강도는 모두 초안으로 들고 있다가 "저장"에서 한 번에 반영
export default function AlarmDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getAppointment(id));

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

function Detail({ appointment: a, reload }: { appointment: AppointmentDetail; reload: () => Promise<boolean> }) {
  const [buffer, setBuffer] = useState(a.bufferMinutes);
  const [kinds, setKinds] = useState(() => savedKinds(a));
  const [levels, setLevels] = useState(() => savedLevels(a));
  const [preview, setPreview] = useState<AlarmTime[]>(a.alarms);
  const [changes, setChanges] = useState<AlarmChange[] | null>(null); // 확인 시트에 보여 줄 바뀌는 알람
  const { busy, run } = useAction();

  // 저장된 값과 다른 곳이 있으면 저장 전 — 저장 버튼이 켜지고, 나갈 때 한 번 물음
  const saved = savedKinds(a);
  const savedLv = savedLevels(a);
  const dirty =
    buffer !== a.bufferMinutes ||
    ringingKinds(a.alarms).some((x) => kinds[x.kind] !== saved[x.kind]) ||
    AXES.some(([axis]) => levels[axis] !== savedLv[axis]);
  useLeaveGuard(dirty);

  // 여유 시간을 바꾸면 알람 시각을 다시 계산 (저장 전 미리 보기)
  useEffect(() => {
    let cancelled = false;
    previewAlarms(a.id, buffer).then((list) => {
      if (!cancelled) setPreview(list);
    });
    return () => {
      cancelled = true;
    };
  }, [a.id, buffer, a.alarms]);

  const first = preview[0] ?? a.alarms[0];
  const margin = a.predictedPrepMinutes - a.beforePrepMinutes - a.prepMinutes;
  const anyManual = AXES.some(([axis]) => levels[axis] != null);

  async function apply() {
    const bufferChanged = buffer !== a.bufferMinutes;
    const { turnedOff, turnedOn } = await saveAlarmSettings(a.id, { bufferMinutes: buffer, kinds, levels });
    setChanges(null);
    toast(
      turnedOff
        ? '알람을 모두 꺼서 이 일정 알람이 꺼졌어요'
        : turnedOn
          ? '알람을 켜서 이 일정 알람도 다시 켰어요'
          : bufferChanged
            ? '알람 시각을 다시 계산했어요'
            : '저장했어요',
    );
    await reload();
  }

  function save() {
    if (!dirty) return;
    void run(async () => {
      // 알람 시각이 5분 이상 바뀌면 한 번 더 확인 — 미리 보기가 늦게 올 수 있어(실데이터는 서버 계산) 저장할 때 다시 계산한 값으로 비교
      if (buffer !== a.bufferMinutes) {
        const moved = changedAlarms(a.alarms, await previewAlarms(a.id, buffer));
        if (moved.some((c) => Math.abs(minutesBetween(c.from, c.to)) >= 5)) {
          setChanges(moved);
          return;
        }
      }
      await apply();
    }, '저장하지 못했어요');
  }

  // 확인 시트 "바꾸기" — 저장과 같은 잠금으로 연타를 막음
  function confirmApply() {
    void run(apply, '저장하지 못했어요');
  }

  // 시트 "그대로 두기" · 바깥 누름 — 알람 시각이 바뀌는 여유 시간만 되돌림 (D34)
  function keep() {
    if (busy) return; // "바꾸기"가 저장하는 중이면 그대로 두기 · 시트 닫기도 기다림
    setBuffer(a.bufferMinutes);
    setChanges(null);
  }

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="H03" />
      <Text variant="title" style={styles.title}>
        알람 설정
      </Text>
      <Text variant="lead" style={styles.lead}>
        {formatDateShort(a.at)} ·{' '}
        <Text variant="lead" tone="ink">
          {formatTime(first.at)} {KIND_LABEL[first.kind]}
        </Text>
      </Text>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          연결 일정
        </Text>
        <View style={styles.between}>
          <Text variant="big">{a.title}</Text>
          <Chip label={IMPORTANCE_LABEL[a.importance]} variant="fill" />
        </View>
        <Text variant="small" tone="sub" style={styles.sub}>
          {formatTime(a.at)} · {a.place} · {a.repeatLabel}
        </Text>
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          이동 조건
        </Text>
        <KeyValueRow first label="출발 위치" value={a.origin} />
        <KeyValueRow label="이동 수단" value={TRANSPORT_LABEL[a.transport]} />
        <KeyValueRow label="예상 이동" value={`${a.travelMinutes}분`} sub={a.travelSource} />
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          준비 시간
        </Text>
        {a.beforePrepMinutes ? <KeyValueRow first label="준비 전 활동" value={`${a.beforePrepMinutes}분`} /> : null}
        <KeyValueRow first={!a.beforePrepMinutes} label="실제 준비" value={`${a.prepMinutes}분`} />
        <KeyValueRow label="P80 여유" value={`+${margin}분`} sub="열 번 중 여덟 번은 늦지 않게" />
        <KeyValueRow label="예측 준비" value={`${a.predictedPrepMinutes}분`} sub="공통 P80 + 개인 보정" />
        <Stepper label="여유 시간" value={buffer} onChange={setBuffer} min={0} max={30} step={5} unit="분" />
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          알람 시각
        </Text>
        <FormulaBox
          lines={[
            `${KIND_LABEL[first.kind]} ${formatTime(first.at)} = 약속 ${formatTime(a.at)} − 여유 ${buffer} − 이동 ${a.travelMinutes} − 준비 ${a.predictedPrepMinutes}`,
            ...(first.kind === 'WAKE' && a.beforePrepMinutes
              ? [`준비 알람은 기상 후 준비 전 활동 ${a.beforePrepMinutes}분 뒤`]
              : []),
          ]}
        />
        {preview.map((x, i) => (
          <KeyValueRow
            key={x.kind}
            first={i === 0}
            label={`${KIND_LABEL[x.kind]}${x.kind === 'ARRIVE' ? ' 목표' : ''}`}
            value={
              <View style={styles.timeRow}>
                <Text variant="bodyStrong">{formatTime(x.at)}</Text>
                {x.kind === 'ARRIVE' ? null : (
                  <Toggle
                    value={kinds[x.kind] ?? x.enabled}
                    onChange={(on) => setKinds((k) => ({ ...k, [x.kind]: on }))}
                    label={`${KIND_LABEL[x.kind]} 알람`}
                  />
                )}
              </View>
            }
          />
        ))}
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          알람 강도
        </Text>
        <Text variant="small" tone="sub">
          자동 {LEVELS[a.intensity.auto].name} · 중요도 {IMPORTANCE_LABEL[a.importance]} {a.intensity.importancePoint}점 + 최근 4주 늦잠
          지각 {a.intensity.lateCount}회 {a.intensity.latePoint}점
        </Text>
        {AXES.map(([axis, name]) => {
          const picked = levels[axis];
          const level = picked ?? a.intensity.auto;
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
        <Text variant="caption" tone="faint" style={styles.note}>
          직접 고른 항목은 자동 계산보다 항상 먼저 적용돼요.
        </Text>
        {anyManual ? (
          <View style={styles.reset}>
            <TextLink label="모두 자동으로 되돌리기" onPress={() => setLevels({ sound: null, voice: null, vibration: null })} />
          </View>
        ) : null}
      </Card>

      <View style={styles.stack}>
        <Button label="저장" onPress={save} disabled={!dirty} loading={busy && changes == null} />
      </View>

      {/* 알람 시각이 바뀌는 저장이면 바뀌는 알람을 전부 보여 주고 한 번 더 물음 */}
      <Sheet visible={changes != null} onClose={keep} title="알람 시각이 바뀌어요">
        <Text variant="small" tone="sub">
          저장하면 아래 알람이 이렇게 바뀌어요.
        </Text>
        <View style={styles.changes}>
          {(changes ?? []).map((c) => (
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
          <Button label="바꾸기" onPress={confirmApply} loading={busy} />
          <Button label="그대로 두기" variant="ghost" onPress={keep} />
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
  sub: { marginTop: 4 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
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
