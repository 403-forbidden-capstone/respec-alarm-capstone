import { useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { useAction } from '@/lib/useAction';

import { BLOCK_TEXT, reportToast } from '../blockTexts';
import { blockUser, submitReport } from '../api';
import type { Person, ReportReason } from '../types';

// 사람 줄 메뉴의 [차단] · [신고] — 확인 창 · api 호출 · 토스트를 맡고, 시트(PersonMenuSheet)는 값 · 콜백만 받음 (친구 4장)
//   onBlocked = 차단한 뒤 부르는 화면이 목록을 새로 읽거나 돌아감 (친구 끊김 · 받은 요청 삭제가 목록에 반영되게)
export function usePersonMenu(onBlocked?: (p: Person) => void) {
  const [person, setPerson] = useState<Person | null>(null);
  const { run } = useAction();

  const close = () => setPerson(null);

  const block = (p: Person) =>
    run(async () => {
      close();
      const ok = await confirm({ title: BLOCK_TEXT.title(p.name), message: BLOCK_TEXT.lines.join('\n'), okLabel: BLOCK_TEXT.ok, destructive: true });
      if (!ok) return;
      await blockUser(p.id);
      toast(BLOCK_TEXT.toast);
      onBlocked?.(p);
    }, '차단하지 못했어요. 다시 해 주세요');

  // 신고는 시트 안의 [신고하기]가 부름 — 실패하면 시트를 열어 둔 채 토스트(useAction), 성공하면 닫고 토스트
  const report = async (p: Person, reason: ReportReason, note: string) => {
    await run(async () => {
      const result = await submitReport({ type: 'USER', id: p.id }, reason, note);
      close();
      toast(reportToast(result));
    }, '신고하지 못했어요. 다시 해 주세요');
  };

  return { open: setPerson, sheetProps: { person, onClose: close, onBlock: block, onReport: report } };
}
