-- 하루 기록 자동 정리 — pg_cron이 10분마다 voice-commit을 서비스 키로 부름 (본문 _shared/ai/auto-commit.ts)
-- [완료]를 안 눌러도 지난 기준일 대화를 정리: 다음 아침 가장 이른 켜진 기상 알람 2시간 전(없으면 KST 04:00) · 마지막 사용자 말 60분 뒤
-- 표 · 칸 변경 없음 — 예약만. batch_notify.sql의 wake-check와 같은 모양 (private.invoke_edge_function, Vault 키 없으면 경고만)
-- voice-commit 새 배포(verify_jwt = false) 전엔 옛 함수가 서비스 키를 로그인 토큰으로 보고 401로 끝남 — 해롭지 않음
-- pg_cron이 없는 곳(PGlite 같은 검사용 DB)에서는 건너뜀. 같은 이름으로 다시 예약하면 갈아끼움

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('voice-auto-commit', '*/10 * * * *', $cmd$select private.invoke_edge_function('voice-commit')$cmd$);
  end if;
end;
$$;
