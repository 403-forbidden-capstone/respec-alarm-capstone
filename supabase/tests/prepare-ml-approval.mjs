// 2024 생활시간조사 연령·휴무 코드: 시험 계정 수동 승인만 검증.
export default async function testPrepareMlApproval(ctx) {
  const { q, as, su, svc, check, expectErr } = ctx;
  const A = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  const B = 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  const C = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
  const fn = 'private.approve_prepare_ml_test_profile($1::uuid,$2::text)';
  for (const [id, email] of [[A,'demo-ml-approval@example.com'],[B,'ordinary@example.com'],[C,'demo-noconsent@example.com']]) {
    await as(null, 'supabase_auth_admin');
    await q('insert into auth.users(id,email) values($1,$2)', [id,email]);
    await su();
  }

  await check('ML 수동 승인: 사용자/anon은 EXECUTE 불가, service_role만 가능, private 함수', async () => {
    await su();
    const [priv] = await q(`select
      has_function_privilege('authenticated','private.approve_prepare_ml_test_profile(uuid,text)','execute') as client,
      has_function_privilege('anon','private.approve_prepare_ml_test_profile(uuid,text)','execute') as anon,
      has_function_privilege('service_role','private.approve_prepare_ml_test_profile(uuid,text)','execute') as service`);
    await as(A);
    const client = await expectErr(() => q('select '+fn,[A,'demo-ml-approval@example.com']), /permission denied/);
    await as(null,'anon');
    const anon = await expectErr(() => q('select '+fn,[A,'demo-ml-approval@example.com']), /permission denied/);
    return !priv.client && !priv.anon && priv.service && client === true && anon === true
      ? true : {priv,client,anon};
  });

  await check('ML 수동 승인: 동의하지 않은 시험 계정 거부 및 자동 생성 없음', async () => {
    await svc();
    const noConsent = await expectErr(() => q('select '+fn,[C,'demo-noconsent@example.com']), /동의/);
    const [count] = await q('select count(*)::int as n from public.prepare_ml_verified_profiles where user_id=$1',[C]);
    return noConsent === true && count.n === 0 ? true : {noConsent,count};
  });

  await check('ML 수동 승인: 일반 계정 및 이름 위장 거부', async () => {
    await as(B);
    await q(`update public.profiles set ml_age_years=34,ml_holiday_code='2',ml_profile_consented_at=now() where user_id=$1`,[B]);
    await svc();
    const ordinary = await expectErr(() => q('select '+fn,[B,'ordinary@example.com']), /데모 시험 계정/);
    const forged = await expectErr(() => q('select '+fn,[A,'demo-wrong@example.com']), /데모 시험 계정/);
    return ordinary === true && forged === true ? true : {ordinary,forged};
  });

  await check('ML 수동 승인: 동의한 demo 계정 24세·휴무5 => 2·5, 코드북버전·동의시각 일치', async () => {
    await as(A);
    await q(`update public.profiles set ml_age_years=24,ml_holiday_code='5',ml_profile_consented_at=now() where user_id=$1`,[A]);
    await su();
    const [before] = await q('select count(*)::int as n from public.prepare_ml_verified_profiles where user_id=$1',[A]);
    await svc();
    const approved = await q('select '+fn+' as ok',[A,'demo-ml-approval@example.com']);
    const [row] = await q(`select v.ml_age_code,v.ml_holiday_code,v.codebook_version,
      (v.consent_at=p.ml_profile_consented_at) as consent_ok
      from public.prepare_ml_verified_profiles v join public.profiles p on p.user_id=v.user_id where v.user_id=$1`,[A]);
    return before.n===0 && approved[0].ok && row.ml_age_code==='2' && row.ml_holiday_code==='5' &&
      row.codebook_version==='2024-time-use-age-holiday-v1' && row.consent_ok === true
      ? true : {before,approved,row};
  });

  await check('ML 수동 승인: 변경·철회하면 기존 검증값 즉시 삭제', async () => {
    await as(A);
    await q(`update public.profiles set ml_holiday_code='1' where user_id=$1`,[A]);
    await svc();
    const [cleared] = await q('select count(*)::int as n from public.prepare_ml_verified_profiles where user_id=$1',[A]);
    await q('select '+fn,[A,'demo-ml-approval@example.com']);
    await as(A);
    await q(`update public.profiles set ml_age_years=null,ml_holiday_code=null,ml_profile_consented_at=null where user_id=$1`,[A]);
    await svc();
    const [revoked] = await q('select count(*)::int as n from public.prepare_ml_verified_profiles where user_id=$1',[A]);
    const denied = await expectErr(() => q('select '+fn,[A,'demo-ml-approval@example.com']), /동의/);
    return cleared.n===0 && revoked.n===0 && denied===true ? true : {cleared,revoked,denied};
  });

  await check('ML 수동 승인: 연령 경계 80세→8, 미응답 휴무 null', async () => {
    await as(A);
    await q(`update public.profiles set ml_age_years=80,ml_holiday_code=null,ml_profile_consented_at=now() where user_id=$1`,[A]);
    await svc();
    await q('select '+fn,[A,'demo-ml-approval@example.com']);
    const [r] = await q('select ml_age_code,ml_holiday_code from public.prepare_ml_verified_profiles where user_id=$1',[A]);
    return r.ml_age_code==='8' && r.ml_holiday_code===null ? true : r;
  });
}
