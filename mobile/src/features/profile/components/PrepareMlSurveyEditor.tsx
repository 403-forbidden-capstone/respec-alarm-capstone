import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Stepper, Text, Toggle, toast } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { isCompletePrepareMlSurvey, type PrepareMlSurvey } from '@/features/profile/prepareMlSurvey';
import type { ProfileFields } from '@/features/profile/types';

type Props = {
  initial: PrepareMlSurvey;
  onSave: (fields: ProfileFields) => Promise<void> | void;
  onRevoke: () => Promise<void> | void;
  onCancel: () => void;
};

export function PrepareMlSurveyEditor({ initial, onSave, onRevoke, onCancel }: Props) {
  const [age, setAge] = useState(initial.ml_age_years ?? 20);
   // Consent requires an explicit current opt-in, not a prechecked switch.
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = isCompletePrepareMlSurvey({ ...initial, ml_age_years: age });

  async function save() {
    if (!ready || !consent || busy) return;
    setBusy(true);
    try {
      await onSave({
        ml_age_years: age,
        ml_school_status: null,
        ml_work_status: null,
        ml_profile_consented_at: new Date().toISOString(),
      });
    } catch (e) {
      toast(userMessage(e, '입력 정보를 저장하지 못했어요'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    setBusy(true);
    try {
      await onRevoke();
    } catch (e) {
      toast(userMessage(e, '정보를 삭제하지 못했어요'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.body}>
      <Text variant="small">
        준비시간 예측 연구를 위한 선택 입력이에요. 입력하지 않아도 기존 알람을 그대로 사용할 수 있어요.
        현재 입력값은 CatBoost 모델에 바로 전달되지 않으며, 조사 코드 매핑·검증 후 별도 활성화가 필요해요.
      </Text>
      <Stepper label="만 나이" value={age} onChange={setAge} min={14} max={100} step={1} unit="세" first />
      <View style={styles.consent}>
        <View style={styles.consentText}>
          <Text variant="bodyStrong">정보 수집·이용에 동의</Text>
          <Text variant="small">
            만 나이를 개인별 준비시간 예측 모델의 입력 후보로 보관합니다.
            알람 추천 목적에만 사용하며, 설정에서 언제든 삭제할 수 있습니다. 친구에게 공유하지 않습니다.
          </Text>
        </View>
        <Toggle value={consent} onChange={setConsent} label="준비시간 예측용 프로필 정보 수집 동의" disabled={busy} />
      </View>
      <Button label="저장" onPress={() => void save()} disabled={!ready || !consent} loading={busy} />
      {initial.ml_profile_consented_at ? (
        <Button label="입력 정보 삭제 · 동의 철회" variant="ghost" onPress={() => void revoke()} loading={busy} />
      ) : null}
      <Button label="취소" variant="plain" onPress={onCancel} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingVertical: 8 },
  consent: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  consentText: { flex: 1, gap: 4 },
});
