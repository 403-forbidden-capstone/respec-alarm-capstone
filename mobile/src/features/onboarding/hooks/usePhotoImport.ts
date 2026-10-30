import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';

import { toast } from '@/components/ui';
import { UserError, userMessage } from '@/lib/errors';

import { extractTimetable } from '../photoApi';
import { mediaTypeOf, photoProblem } from '../photo';
import type { ImportBatch } from '../timetableImport';

// [시간표 사진으로 넣기] — 갤러리에서 사진 한 장 고르기 → 서버가 읽음 → 가져온 수업을 돌려줌
// 안드로이드 13 이상은 시스템 사진 고르기 창이라 사진 권한을 따로 안 물음. 사진 편집(자르기)은 끔 — 캡처 그대로 읽는 게 가장 또렷함
// 돌려주는 값: 가져온 수업 / 고르지 않고 닫았으면 null / 실패면 토스트 뒤 null
export function usePhotoImport() {
  const [reading, setReading] = useState(false);

  async function pick(): Promise<ImportBatch | null> {
    if (reading) return null;
    setReading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, base64: true, quality: 0.9, selectionLimit: 1 });
      if (result.canceled || !result.assets[0]) return null;
      const asset = result.assets[0];
      const problem = photoProblem(asset);
      if (problem) throw new UserError(problem);
      // mimeType은 photoProblem이 확인했음
      return await extractTimetable({ base64: asset.base64 as string, mediaType: mediaTypeOf(asset.mimeType) as NonNullable<ReturnType<typeof mediaTypeOf>> });
    } catch (e) {
      toast(userMessage(e, '사진을 읽지 못했어요. 다시 해 주세요'));
      return null;
    } finally {
      setReading(false);
    }
  }

  return { reading, pick };
}
