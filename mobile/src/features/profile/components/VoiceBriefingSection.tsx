// 설정 > 알람 · 음성 카드 안의 음성 줄(카드 · 제목은 설정 화면이 그림) — 켜기(profiles.alarm_voice_prefs) + 말소리 약 · 중 · 강(profiles.preferred_voice_tone)
//   말소리 = 기상 알람 AI 음성 시작 단계(약 1 · 중 2 · 강 3)의 기본값. 비면(아무것도 안 고름) 일정 강도대로 자동, 일정에서 직접 고른 말소리가 이김
//   말투(tone) · 목소리(voice) 선택은 뺌 — 저장돼 있던 값은 cleanPrefs가 그대로 두지만 실제 알람 목소리에 안 씀(briefing.ts ANDROID_VOICE_INDEX)
//   말소리를 누르면 onPickTone(미리 듣기 + 저장, features/profile/hooks/useVoiceTone). [기본값으로]는 모든 칸을 비움. 값 · 콜백만 받음
//   어제 대화(직접 말하거나 확인한 다짐 · 목표)는 끄는 설정 없이 늘 기상 브리핑에 넣음 (서버 briefing-run.ts)
//   알람 소리 · 진동 · 세기(볼륨)는 여기서 안 바꿈 — 알람마다 기존 강도 화면의 축 선택이 맡고, AI 음성이 그 값을 바꾸지 않음
import { StyleSheet, View } from 'react-native';

import { Segmented, Text, Toggle } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { colors, size } from '@/theme';
import { VOICE_TONE_OPTIONS, type VoiceTone } from '@/features/profile/voicePreview';
import { cleanPrefs, type VoicePrefs } from '@shared/briefing.ts';

type Props = {
  value: unknown; // profiles.alarm_voice_prefs 그대로 (모르는 칸은 cleanPrefs가 버림)
  tone: VoiceTone | null; // profiles.preferred_voice_tone (누른 직후 값) — 비면 자동이라 아무것도 안 켜짐
  onSave: (next: { alarm_voice_prefs?: VoicePrefs; preferred_voice_tone?: VoiceTone | null }) => void;
  onPickTone: (tone: VoiceTone) => void;
  disabled?: boolean;
  toneDisabled?: boolean; // 가짜 데이터 모드는 다른 칸은 보기만이고 말소리만 고를 수 있음
};

export function VoiceBriefingSection({ value, tone, onSave, onPickTone, disabled, toneDisabled = disabled }: Props) {
  const prefs = cleanPrefs(value);
  // 한 칸만 바꿈. undefined면 그 칸을 지워 자동(기본값)으로
  const set = <K extends keyof VoicePrefs>(key: K, next: VoicePrefs[K] | undefined) => {
    const copy: VoicePrefs = { ...prefs };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onSave({ alarm_voice_prefs: copy });
  };
  const enabled = prefs.enabled ?? true;

  // 카드는 부르는 쪽(설정 "알람 · 음성")이 그림 — 줄만 이어 붙임
  return (
    <>
      <View style={[styles.row, styles.divider]}>
        <View style={styles.rowText}>
          <Text variant="body">알람이 울릴 때 읽어 주기</Text>
          <Text variant="small" tone="sub">
            기상 · 출발 알람 때 일정을 읽어요
          </Text>
        </View>
        <Toggle value={enabled} onChange={(on) => set('enabled', on ? undefined : false)} label="AI 음성 브리핑" disabled={disabled} />
      </View>
      {enabled ? (
        <View style={styles.tone}>
          <Text variant="small" tone="sub" style={styles.label}>
            말소리
          </Text>
          <Segmented options={VOICE_TONE_OPTIONS} value={tone ?? ('' as VoiceTone)} onChange={onPickTone} disabled={toneDisabled ? VOICE_TONE_OPTIONS.map(([v]) => v) : undefined} />
        </View>
      ) : null}
      {Object.keys(prefs).length || tone ? (
        <View style={styles.reset}>
          <TextLink label="기본값으로" onPress={() => onSave({ alarm_voice_prefs: {}, preferred_voice_tone: null })} disabled={disabled} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  tone: { paddingBottom: 6 },
  reset: { alignItems: 'flex-end', paddingTop: 4 },
  row: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 8 },
  rowText: { flex: 1, minWidth: 0 },
  label: { marginTop: 10, marginBottom: 6 },
});
