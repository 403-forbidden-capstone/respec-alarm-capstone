import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Text, toast } from '@/components/ui';
import { HandleStep } from '@/features/onboarding/views/HandleStep';
import { NicknameStep } from '@/features/onboarding/views/NicknameStep';
import { PrepareStep, type PrepareValues } from '@/features/onboarding/views/PrepareStep';
import { SleepStep } from '@/features/onboarding/views/SleepStep';
import { cleanHandle, cleanNickname, NICKNAME_MAX } from '@/features/onboarding/validate';
import { userMessage } from '@/lib/errors';

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

// 아이디 바꾸기 — 저장은 부르는 쪽(ChangeHandleSheet)이 change_my_handle로 함. onSave가 문구를 돌려주면 그게 저장하지 못한 이유(TAKEN · LIMIT …), null이면 성공
//   hint = 아이디 줄 안내(자동 아이디면 '바꿔 보세요', 30일 안이면 다음 가능 시각). locked면 입력은 막고 안내만 (서버도 LIMIT으로 막음)
export function HandleEditor({
  initial,
  hint,
  onSave,
  onCancel,
}: {
  initial: string | null;
  hint: { text: string; locked: boolean };
  onSave: (handle: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      setError(await onSave(cleanHandle(draft)));
    } catch (e) {
      toast(userMessage(e, '저장하지 못했어요'));
    } finally {
      setBusy(false); // 성공하면 시트가 닫혀 이 화면이 사라질 수도 있음 — 그때는 아무 일도 안 함
    }
  }

  return (
    <View>
      <HandleStep
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setError(null);
        }}
        error={error}
      />
      <Text variant="caption" tone={hint.locked ? 'warn' : undefined} style={styles.hint}>
        {hint.text}
      </Text>
      <View style={styles.buttons}>
        <Button label="저장" onPress={save} disabled={hint.locked || !canSaveHandle(initial, draft)} loading={busy} />
        <Button variant="plain" label="취소" onPress={onCancel} disabled={busy} />
      </View>
    </View>
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
  hint: { marginHorizontal: 4, marginTop: 6 },
});
