// 저장 중에 값이 또 바뀌면 끝난 뒤 마지막 값을 이어서 저장 (중간 값은 건너뜀) — 말소리 선택(hooks/useVoiceTone)에서 씀
//   onSaved는 저장을 마칠 때마다 그 값으로 부름. 실패하면 그때까지 저장된 값은 onSaved로 이미 알렸고 오류를 그대로 던짐
export async function saveLatest<T>(latest: () => T, save: (value: T) => Promise<void>, onSaved: (value: T) => void): Promise<void> {
  let stored: { value: T } | null = null;
  while (!stored || latest() !== stored.value) {
    const value = latest();
    await save(value);
    stored = { value };
    onSaved(value);
  }
}
