import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui';
import { HandleStep } from '@/features/onboarding/views/HandleStep';
import { NicknameStep } from '@/features/onboarding/views/NicknameStep';
import { PrepareStep, type PrepareValues } from '@/features/onboarding/views/PrepareStep';
import { SleepStep } from '@/features/onboarding/views/SleepStep';
import { cleanHandle, cleanNickname, NICKNAME_MAX } from '@/features/onboarding/validate';

import { canSaveHandle, canSaveNickname, isPrepareChanged } from '../edit';
import type { ProfileFields, WakeSensitivity } from '../types';

// 설정의 편집 시트 안에 들어가는 편집기 — 시트 내용은 루트에서 그려져 화면의 Context를 못 받으므로 각자 자기 draft state를 가짐
// 값 · 콜백만 받음: 저장(api 호출 · 화면 갱신 · 토스트)은 부르는 화면이 함. 온보딩 단계 부품을 그대로 씀
type EditorProps<T> = {
  initial: T;
  onSave: (fields: ProfileFields) => Promise<void> | void;
  onCancel: () => void;
};

// [저장] + [취소] — 바뀐 게 없으면 저장을 못 누르고, 저장하는 동안 버튼 안에 돌아가는 표시
function EditorFrame({ children, canSave, fields, onSave, onCancel }: { children: ReactNode; canSave: boolean; fields: () => ProfileFields } & Pick<EditorProps<unknown>, 'onSave' | 'onCancel'>) {
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await onSave(fields());
    } finally {
      setBusy(false); // 성공하면 시트가 닫혀 이 화면이 사라질 수도 있음 — 그때는 아무 일도 안 함
    }
  }

  return (
    <View>
      {children}
      <View style={styles.buttons}>
        <Button label="저장" onPress={save} disabled={!canSave} loading={busy} />
        <Button variant="plain" label="취소" onPress={onCancel} disabled={busy} />
      </View>
    </View>
  );
}

export function NicknameEditor({ initial, onSave, onCancel }: EditorProps<string>) {
  const [draft, setDraft] = useState(initial);
  return (
    <EditorFrame canSave={canSaveNickname(initial, draft)} fields={() => ({ nickname: cleanNickname(draft) })} onSave={onSave} onCancel={onCancel}>
      <NicknameStep value={draft} onChange={setDraft} max={NICKNAME_MAX} />
    </EditorFrame>
  );
}

// 아이디 중복 확인은 저장하는 쪽이 함. L3 changeHandle 오면 교체 (30일에 한 번 바꾸는 제한은 L3 몫, D95)
export function HandleEditor({ initial, onSave, onCancel }: EditorProps<string | null>) {
  const [draft, setDraft] = useState(initial ?? '');
  return (
    <EditorFrame canSave={canSaveHandle(initial, draft)} fields={() => ({ handle: cleanHandle(draft) })} onSave={onSave} onCancel={onCancel}>
      <HandleStep value={draft} onChange={setDraft} />
    </EditorFrame>
  );
}

export function SleepEditor({ initial, onSave, onCancel }: EditorProps<WakeSensitivity>) {
  const [draft, setDraft] = useState(initial);
  return (
    <EditorFrame canSave={draft !== initial} fields={() => ({ wake_sensitivity: draft })} onSave={onSave} onCancel={onCancel}>
      <SleepStep value={draft} onChange={setDraft} />
    </EditorFrame>
  );
}

// 준비 시간 · 여유 시간 · 이동 수단 · 깨우는 여유를 한 시트로
export function PrepareEditor({ initial, onSave, onCancel }: EditorProps<PrepareValues>) {
  const [draft, setDraft] = useState(initial);
  return (
    <EditorFrame
      canSave={isPrepareChanged(initial, draft)}
      fields={() => ({
        default_prepare_minutes: draft.prepare,
        default_buffer_minutes: draft.buffer,
        default_transport: draft.transport,
        wake_margin: draft.margin,
      })}
      onSave={onSave}
      onCancel={onCancel}
    >
      <PrepareStep values={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
    </EditorFrame>
  );
}

const styles = StyleSheet.create({
  buttons: { marginTop: 16, gap: 4 },
});
