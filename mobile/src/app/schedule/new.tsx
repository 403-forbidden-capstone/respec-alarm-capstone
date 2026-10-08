import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, Field, Screen, Sheet, Text, toast, TopBar } from '@/components/ui';
import { createAppointment, defaultDraft, draftAt, draftDates, estimateAppointment, listPlaces } from '@/features/alarm/api';
import { OptionGrid } from '@/features/alarm/components/OptionGrid';
import { SelectRow } from '@/features/alarm/components/SelectRow';
import { TimeRow } from '@/features/alarm/components/TimeRow';
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
import { dayKey, formatDateParen, formatDateShort, formatTime, formatTime24 } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { userMessage } from '@/lib/errors';

const DATES = draftDates();
const DATE_OPTIONS = DATES.map((d) => [dayKey(d), formatDateParen(d)] as const);
const REPEAT_OPTIONS = [
  ['NONE', '반복 없음'],
  ['WEEKLY', '매주 같은 요일'],
] as const;
const TRANSPORT_OPTIONS = (['TRANSIT', 'CAR', 'WALK'] as const).map((t) => [t, TRANSPORT_LABEL[t]] as const);
const IMPORTANCE_OPTIONS = (['LOW', 'NORMAL', 'HIGH'] as const).map((v) => [v, IMPORTANCE_LABEL[v]] as const);

// H05 새 일정 만들기 — 입력하면 이동시간 · 준비 시간으로 알람을 계산해 확인 시트로 보여 줌
// from=chat: AI 대화(A02)에서 찾은 일정을 "수정"으로 연 것 — 찾은 값으로 채우고, 저장하면 대화로 돌아감
export default function NewScheduleScreen() {
  const fromParam = useLocalSearchParams<{ from?: string }>().from;
  // 대화에서 왔고 찾은 일정이 아직 대기일 때만 — 이미 확인한 카드면 보통 새 일정으로 (두 벌 저장 막기)
  const [fromChat] = useState(() => fromParam === 'chat' && foundScheduleDraft() != null);
  const { data: places } = useLoad(listPlaces);
  const [draft, setDraft] = useState(() => (fromChat ? foundScheduleDraft() : null) ?? defaultDraft());
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));

  async function calculate() {
    if (!draft.title.trim()) {
      toast('일정명을 입력해 주세요');
      return;
    }
    setEstimate(await estimateAppointment(draft));
  }

  // 두 번 눌러도 일정이 한 번만 들어가게 저장 중에는 막음
  async function save() {
    if (!estimate || saving) return;
    setSaving(true);
    try {
      const saved = fromChat ? await saveFoundSchedule(estimate) : await createAppointment(estimate);
      setEstimate(null);
      toast(`알람 ${saved.alarms.filter((x) => x.kind !== 'ARRIVE').length}개를 맞췄어요`);
      if (fromChat && router.canGoBack()) router.back();
      else router.dismissTo('/alarms');
    } catch (e) {
      toast(userMessage(e, '저장하지 못했어요'));
    } finally {
      setSaving(false);
    }
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
        <Field first label="일정명" value={draft.title} onChangeText={(v) => set('title', v)} maxLength={30} />
        <SelectRow
          label="날짜"
          value={dayKey(draft.date)}
          options={DATE_OPTIONS}
          onChange={(key) => set('date', DATES.find((d) => dayKey(d) === key) ?? draft.date)}
        />
        <TimeRow label="시간" value={draftAt(draft.date, draft.time)} onChange={(at) => set('time', formatTime24(at))} />
        <SelectRow label="반복" value={draft.repeat} options={REPEAT_OPTIONS} onChange={(v) => set('repeat', v)} />
      </Card>

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
        <Field first label="준비물" value={draft.items} onChangeText={(v) => set('items', v)} placeholder="쉼표로 구분" />
      </Card>

      <View style={styles.stack}>
        <Button label="저장하고 알람 설정하기" onPress={calculate} />
      </View>

      <Sheet visible={estimate != null} onClose={() => setEstimate(null)} title="알람을 이렇게 맞출게요">
        {estimate ? <CalcSteps estimate={estimate} onSave={save} onEdit={() => setEstimate(null)} /> : null}
      </Sheet>
    </Screen>
  );
}

// 계산 순서 (.calc) — 이동 → 공통 P80 → 개인 보정 → 알람 시각 → 강도
function CalcSteps({ estimate: e, onSave, onEdit }: { estimate: Estimate; onSave: () => void; onEdit: () => void }) {
  const a = e.appointment;
  const first = a.alarms[0];
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
      <View style={styles.chips}>
        {a.alarms.map((x) => (
          <Chip key={x.kind} label={`${KIND_LABEL[x.kind]} ${formatTime(x.at)}`} variant="fill" />
        ))}
      </View>
      <View style={styles.stack}>
        <Button label="알람 저장" onPress={onSave} />
        <Button label="돌아가서 수정" variant="plain" onPress={onEdit} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  optLabel: { marginTop: 12, marginBottom: 8 },
  stack: { gap: 10, marginTop: 16 },
  steps: { marginVertical: 14 },
  step: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1 },
  stepDetail: { marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
