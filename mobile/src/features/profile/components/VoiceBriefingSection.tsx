// 설정 > AI 음성 브리핑 — 기상 알람이 울릴 때 읽어 주는 Android TTS 목소리 · 전날 대화 사용 (profiles.alarm_voice_prefs)
//   말투(tone) 선택은 뺌 — 단계별 높낮이 · 속도가 고정값이 돼 말투가 바꾸는 것이 없음 (저장된 값은 cleanPrefs가 그대로 둠)
//   "자동"은 칸을 비움 = 일정 중요도별 개발팀 기본값. [기본값으로]는 모든 칸을 비움. 값 · 콜백만 받고 저장은 설정 화면이 함
//   알람 소리 · 진동 · 세기(볼륨)는 여기서 안 바꿈 — 알람마다 기존 강도 화면의 축 선택이 맡고, AI 음성이 그 값을 바꾸지 않음
import { StyleSheet, View } from 'react-native';

import { Button, Card, SectionHeader, Segmented, Text, Toggle } from '@/components/ui';
import { size } from '@/theme';
import { cleanPrefs, VOICES, type VoicePrefs } from '@shared/briefing.ts';

const AUTO = 'auto';
const VOICE_OPTIONS = [[AUTO, '자동'], ...VOICES.map((v) => [v.id, v.label] as const)] as const;
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
        <Row label="알람이 울릴 때 읽어 주기" note="기상 알람은 오늘 일정과 어제 다짐을, 출발 알람은 일정 시각과 준비물을 읽어요">
          <Toggle value={enabled} onChange={(on) => set('enabled', on ? undefined : false)} label="AI 음성 브리핑" disabled={disabled} />
        </Row>
        {enabled ? (
          <>
            <Text variant="small" tone="sub" style={styles.label}>
              AI 목소리 (자동 = 일정 중요도에 맞춤)
            </Text>
            <Segmented options={VOICE_OPTIONS} value={prefs.voice ?? AUTO} onChange={(v) => set('voice', v === AUTO ? undefined : v)} disabled={disabled ? VOICE_OPTIONS.map(([v]) => v) : undefined} />
            <Text variant="small" tone="sub" style={styles.label}>
              1 · 2단계는 선택한 Android TTS 목소리로 읽고, 한 번 미루면 더 높고 빠르게 바뀌어요. 두 번 미루거나 여유가 5분 이하면 3단계, 여유가 0분이면 4단계 Gemini 음성으로 바뀝니다. Gemini 목소리는 직접 고를 수 없어요.
            </Text>
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
