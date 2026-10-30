import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { UserError, userMessage } from '@/lib/errors';

import { extractTimetable } from '../photoApi';
import { preparePhoto } from '../photo';
import type { ImportBatch } from '../timetableImport';

// [시간표 사진으로 넣기] — 갤러리에서 사진 한 장 고르기 → 서버가 읽음 → 가져온 수업을 돌려줌
// 안드로이드 13 이상은 시스템 사진 고르기 창이라 사진 권한을 따로 안 물음. 사진 편집(자르기)은 끔 — 캡처 그대로 읽는 게 가장 또렷함
// quality 1 = 안드로이드는 원본 바이트 그대로(1보다 작으면 PNG·WebP도 JPEG로 다시 압축해 파일 종류와 바이트가 어긋남)
// 돌려주는 값: 가져온 수업 / 고르지 않고 닫았으면 null / 실패면 토스트 뒤 null / 읽는 사이 화면이 사라졌으면 null (뒤늦게 온 결과로 다른 화면을 건드리지 않게)
export function usePhotoImport() {
  const [reading, setReading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function pick(): Promise<ImportBatch | null> {
    if (reading) return null;
    setReading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, base64: true, quality: 1, selectionLimit: 1 });
      if (result.canceled || !result.assets[0]) return null;
      const prepared = preparePhoto(result.assets[0]);
      if ('problem' in prepared) throw new UserError(prepared.problem);
      const batch = await extractTimetable(prepared.photo);
      return alive.current ? batch : null;
    } catch (e) {
      if (alive.current) toast(userMessage(e, '사진을 읽지 못했어요. 다시 해 주세요'));
      return null;
    } finally {
      if (alive.current) setReading(false);
    }
  }

  return { reading, pick };
}
