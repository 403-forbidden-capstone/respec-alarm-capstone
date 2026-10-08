import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, KeyValueRow, Screen, Sheet, Stepper, Text, toast, Toggle, TopBar } from '@/components/ui';
import {
  getAppointment,
  previewAlarms,
  resetIntensity,
  saveBuffer,
  setAlarmEnabled,
  setIntensity,
} from '@/features/alarm/api';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { TextLink } from '@/features/alarm/components/TextLink';
import {
  AXES,
  IMPORTANCE_LABEL,
  KIND_LABEL,
  LEVELS,
  TRANSPORT_LABEL,
  type AlarmTime,
  type AppointmentDetail,
  type Level,
} from '@/features/alarm/types';
import { formatDateShort, formatTime, minutesBetween } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const LEVEL_OPTIONS = LEVELS.map((l, i) => [i as Level, l.name] as const);

// H03 알람 설정 — 연결 일정 · 이동 조건 · 준비 시간 · 여유를 바꾸면 다시 계산 · 강도 직접 고르기
export default function AlarmDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, reload } = useLoad(() => getAppointment(id));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} />
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} />
        <Text variant="body" tone="sub">
          일정을 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }
  return <Detail key={data.id} appointment={data} reload={reload} />;
}

function Detail({ appointment: a, reload }: { appointment: AppointmentDetail; reload: () => void }) {
  const [buffer, setBuffer] = useState(a.bufferMinutes);
  const [preview, setPreview] = useState<AlarmTime[]>(a.alarms);
  const [confirm, setConfirm] = useState(false);
  const saving = useRef(false);

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
  const before = a.alarms[0];
  const margin = a.predictedPrepMinutes - a.beforePrepMinutes - a.prepMinutes;
  const anyManual = AXES.some(([axis]) => a.intensity.axes[axis].manual);

  async function save() {
    if (saving.current) return; // 두 번 눌러도 한 번만 (다시 계산 · 저장이 겹치지 않게)
    if (buffer === a.bufferMinutes) {
      toast('바뀐 내용이 없어요');
      return;
    }
    saving.current = true;
    try {
      // 기존보다 5분 이상 바뀌면 한 번 더 확인 — 미리 보기가 늦게 올 수 있어(실데이터는 서버 계산) 저장할 때 다시 계산한 값으로 비교
      const next = (await previewAlarms(a.id, buffer))[0] ?? first;
      if (Math.abs(minutesBetween(before.at, next.at)) >= 5) setConfirm(true);
      else await apply();
    } finally {
      saving.current = false;
    }
  }

  async function apply() {
    await saveBuffer(a.id, buffer);
    setConfirm(false);
    toast('알람 시각을 다시 계산했어요');
    reload();
  }

  function keep() {
    setBuffer(a.bufferMinutes);
    setConfirm(false);
  }

  async function toggleKind(kind: AlarmTime['kind'], on: boolean) {
    await setAlarmEnabled(a.id, kind, on);
    reload();
  }

  async function pickLevel(axis: (typeof AXES)[number][0], level: Level) {
    await setIntensity(a.id, axis, level);
    reload();
  }

  async function resetLevels() {
    await resetIntensity(a.id);
    reload();
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
                  <Toggle value={x.enabled} onChange={(on) => toggleKind(x.kind, on)} label={`${KIND_LABEL[x.kind]} 알람`} />
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
          const { level, manual } = a.intensity.axes[axis];
          return (
            <View key={axis}>
              <View style={styles.axis}>
                <View style={styles.axisName}>
                  <Text variant="rowLabel" tone="sub">
                    {name}
                  </Text>
                  {manual ? (
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
                  onChange={(next) => pickLevel(axis, next)}
                />
              </View>
              <Text variant="label" tone="faint" align="right" style={styles.axisDesc}>
                {LEVELS[level][axis]}
              </Text>
            </View>
          );
        })}
        <Text variant="caption" tone="faint" style={styles.note}>
          직접 고른 항목은 자동 계산보다 항상 먼저 적용돼요.
        </Text>
        {anyManual ? (
          <View style={styles.reset}>
            <TextLink label="모두 자동으로 되돌리기" onPress={resetLevels} />
          </View>
        ) : null}
      </Card>

      <View style={styles.stack}>
        <Button label="저장" onPress={save} />
      </View>

      <Sheet visible={confirm} onClose={keep} title={`${KIND_LABEL[before.kind]} 알람 시각이 바뀌어요`}>
        <Text variant="small" tone="sub">
          {formatTime(before.at)} → {formatTime(first.at)}
          {'\n'}기존보다 5분 이상 바뀌면 한 번 더 확인해요.
        </Text>
        <View style={styles.stack}>
          <Button label="바꾸기" onPress={apply} />
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
  axis: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  axisName: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  manual: { backgroundColor: colors.chip, borderRadius: 8, paddingHorizontal: 6, overflow: 'hidden' },
  axisDesc: { marginTop: 4 },
  note: { marginTop: 10 },
  reset: { marginTop: 6, alignSelf: 'flex-start' },
  stack: { gap: 10, marginTop: 16 },
});
