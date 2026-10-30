import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { failedAlarmCount, onFailedAlarmsChange } from '@/lib/alarmSync';

import { onPermissionsChange, readPermissions } from '../read';
import type { PermissionSnapshot } from '../types';

const same = (a: PermissionSnapshot, b: PermissionSnapshot) => (Object.keys(a) as (keyof PermissionSnapshot)[]).every((key) => a[key] === b[key]);

// 폰 권한 상태 — 처음 한 번, 앱이 앞에 올 때마다(설정에서 돌아올 때), 묻기 · 설정 열기 뒤(onPermissionsChange)에 다시 읽음
// 처음 읽는 동안은 snapshot이 null
export function usePermissions(): { snapshot: PermissionSnapshot | null; refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const alive = useRef(true);
  const latest = useRef(0); // 읽기가 겹치면 가장 나중에 시작한 것만 반영

  const refresh = useCallback(async () => {
    const id = ++latest.current;
    const next = await readPermissions();
    if (!alive.current || id !== latest.current) return; // 언마운트 뒤 · 더 새 읽기가 있으면 버림
    setSnapshot((prev) => (prev && same(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    const off = onPermissionsChange(() => void refresh());
    return () => {
      alive.current = false;
      subscription.remove();
      off();
    };
  }, [refresh]);

  return { snapshot, refresh };
}

// 폰에 못 건 알람 수 (lib/alarmSync) — 바뀌면 다시 그림
export function useFailedAlarmCount(): number {
  return useSyncExternalStore(onFailedAlarmsChange, failedAlarmCount);
}
