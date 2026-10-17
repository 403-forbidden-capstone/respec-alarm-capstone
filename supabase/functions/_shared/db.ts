// DB 오류 → 서버 함수 오류. 원문(테이블 · 칼럼 이름)은 서버 로그에만 남기고 사용자에게는 일반 문구 (8장 8.1)
import { HttpError } from './errors.ts';

type PgError = { message: string; code?: string; details?: string | null; hint?: string | null };

export function dbFail(context: string, error: PgError): never {
  console.error(`[db] ${context}:`, error.code ?? '', error.message, error.details ?? '');
  if (error.code === '42501') throw new HttpError('FORBIDDEN', '이 작업을 할 권한이 없어요');
  if (error.code === '23505') throw new HttpError('CONFLICT', '이미 같은 내용이 있어요. 새로고침한 뒤 다시 시도해 주세요');
  throw new HttpError('INTERNAL', '데이터를 처리하지 못했어요. 잠시 후 다시 시도해 주세요');
}

// supabase-js 결과에서 data만 꺼냄. error가 있으면 던짐
export function must<T>(context: string, result: { data: T | null; error: PgError | null }): T {
  if (result.error) dbFail(context, result.error);
  return result.data as T;
}
