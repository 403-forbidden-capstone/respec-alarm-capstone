// 설정 > AI 음성 브리핑 — 기상 알람이 울릴 때 읽어 주는 AI 목소리 · 말투 · 강한 코칭 범위 · 전날 대화 사용 (profiles.alarm_voice_prefs)
//   "자동"은 칸을 비움 = 일정 중요도별 개발팀 기본값. [기본값으로]는 모든 칸을 비움. 값 · 콜백만 받고 저장은 설정 화면이 함
//   알람 소리 · 진동 · 세기(볼륨)는 여기서 안 바꿈 — 알람마다 기존 강도 화면의 축 선택이 맡고, AI 음성이 그 값을 바꾸지 않음
import { StyleSheet, View } from 'react-native';

import { Button, Card, SectionHeader, Segmented, Text, Toggle } from '@/components/ui';
import { size } from '@/theme';
import { cleanPrefs, DEFAULT_COACH_MAX, TONES, VOICES, type ToneKey, type UrgencyLevel, type VoicePrefs } from '@shared/briefing.ts';

const AUTO = 'auto';
const VOICE_OPTIONS = [[AUTO, '자동'], ...VOICES.map((v) => [v.id, v.label] as const)] as const;
const TONE_OPTIONS = [[AUTO, '자동'], ...(Object.keys(TONES) as ToneKey[]).map((k) => [k, TONES[k].label] as const)] as const;
const COACH_OPTIONS = [
  ['1', '부드럽게'],
  ['2', '단호하게'],
  ['3', '긴급 경고'],
  ['4', '소리치기'],
] as const;

type Props = {
  value: unknown; // profiles.alarm_voice_prefs 그대로 (모르는 칸은 cleanPrefs가 버림)
  onSave: (next: VoicePrefs) => void;
  disabled?: boolean;
};

export function VoiceBriefingSection({ value, onSave, disabled }: Props) {
  const prefs = cleanPrefs(value);
  // 한 칸만 바꿈. undefined면 그 칸을 지워 자동(기본값)으로
  const set = <K extends keyof VoicePrefs>(key: K, next: VoicePrefs[K] | undefined) => {
    const copy: VoicePrefs = { ...prefs };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onSave(copy);
  };
  const enabled = prefs.enabled ?? true;

  return (
    <>
      <SectionHeader title="AI 음성 브리핑" />
      <Card>
        <Row label="기상 알람에서 AI가 읽어 주기" note="알람이 울릴 때 오늘 일정과 어제 다짐을 함께 읽어요">
          <Toggle value={enabled} onChange={(on) => set('enabled', on ? undefined : false)} label="AI 음성 브리핑" disabled={disabled} />
        </Row>
        {enabled ? (
          <>
            <Text variant="small" tone="sub" style={styles.label}>
              AI 목소리 (자동 = 일정 중요도에 맞춤)
            </Text>
            <Segmented options={VOICE_OPTIONS} value={prefs.voice ?? AUTO} onChange={(v) => set('voice', v === AUTO ? undefined : v)} disabled={disabled ? VOICE_OPTIONS.map(([v]) => v) : undefined} />
            <Text variant="small" tone="sub" style={styles.label}>
              평소 말투
            </Text>
            <Segmented options={TONE_OPTIONS} value={prefs.tone ?? AUTO} onChange={(v) => set('tone', v === AUTO ? undefined : (v as ToneKey))} disabled={disabled ? TONE_OPTIONS.map(([v]) => v) : undefined} />
            <Row label="늦을 것 같으면 말투 강하게" note="미루기를 거듭하거나 준비 시간이 모자라면 점점 단호하게 깨워요">
              <Toggle value={prefs.escalate ?? true} onChange={(on) => set('escalate', on ? undefined : false)} label="말투 자동 강화" disabled={disabled} />
            </Row>
            {prefs.escalate ?? true ? (
              <>
                <Text variant="small" tone="sub" style={styles.label}>
                  가장 강하게는 어디까지
                </Text>
                <Segmented
                  options={COACH_OPTIONS}
                  value={String(prefs.coachMax ?? DEFAULT_COACH_MAX) as (typeof COACH_OPTIONS)[number][0]}
                  onChange={(v) => set('coachMax', Number(v) === DEFAULT_COACH_MAX ? undefined : (Number(v) as UrgencyLevel))}
                  disabled={disabled ? COACH_OPTIONS.map(([v]) => v) : undefined}
                />
                <Text variant="small" tone="sub" style={styles.label}>
                  소리치기는 중요한 일정에서 미루기를 거듭해 늦기 직전일 때만 써요
                </Text>
              </>
            ) : null}
            <Row label="어제 대화 내용 넣기" note="AI 대화에서 직접 말한 다짐 · 목표만 써요. 끄면 일정만 읽어요">
              <Toggle value={prefs.personal ?? true} onChange={(on) => set('personal', on ? undefined : false)} label="어제 대화 내용 넣기" disabled={disabled} />
            </Row>
          </>
        ) : null}
        <Text variant="small" tone="sub" style={styles.label}>
          알람 소리 · 진동 · 세기는 알람마다 강도 설정에서 바꿔요. AI 음성은 그 설정을 바꾸지 않아요
        </Text>
        {Object.keys(prefs).length ? <Button label="기본값으로" small onPress={() => onSave({})} disabled={disabled} /> : null}
      </Card>
    </>
  );
}

function Row({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text variant="body">{label}</Text>
        <Text variant="small" tone="sub">
          {note}
        </Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginVertical: 6 },
  rowText: { flex: 1, minWidth: 0 },
  label: { marginTop: 10, marginBottom: 6 },
});
