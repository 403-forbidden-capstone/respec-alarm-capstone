// Test proposed permission policy after the existing legacy regression suite.
// Apply only to the disposable PGlite database; never target production.
export default async function groupCommonSharing({ q, as, su, check, expectErr, readFileSync, execSql }) {
  const uid = n => `79000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const [a,b,c,d] = [1,2,3,4].map(uid);
  const call = async (u, sql, args=[]) => {
    await as(u);
    try { return (await q('select '+sql+' as r',args))[0].r; }
    finally { await su(); }
  };
  const rule = (u,g) => call(u,'public.get_common_group_rule($1)',[g]);
  const save = (u,g,v,wake=true,trip=true,view=true,edit=true) =>
    call(u,'public.save_common_group_rule($1,$2,$3,$4,$5,$6)',[g,v,view,edit,wake,trip]);
  let g,code,friend,version,first,second;
  await check('COMMON-01: policy SQL applies to existing database', async () => {
    await su();
    // Run the candidate script as a single transaction (as a migration would).
    await q('begin');
    try {
      // PGlite query handles single statements; SQL bodies contain semicolons.
      // Use the provided exec callback for the full SQL document.
      await execSql(readFileSync(new URL('../ops/group-common-sharing-draft.sql',import.meta.url),'utf8'));
      await q('commit');
      return true;
    } catch (e) { await q('rollback'); throw e; }
  });
  await check('COMMON-02: create fixtures, group, and friend', async () => {
    for (const [i,u] of [a,b,c,d].entries()) {
      await as(null,'supabase_auth_admin');
      await q('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[u,`common-rule-${i}@example.com`,JSON.stringify({name:`Common ${i}`})]);
      await su();
      await q('update public.profiles set onboarded_at=now(),handle=$2 where user_id=$1',[u,`common_rule_${i}`]);
    }
    await call(a,'public.send_friend_request($1)',[b]);
    await call(b,'public.accept_friend_request($1)',[a]);
    friend=(await q('select friend_id from public.friends where requester_id=$1 and addressee_id=$2',[a,b]))[0]?.friend_id;
    await as(a);
    try {
      const row=(await q("insert into public.groups(group_name,owner_id) values('Common policy fixture',$1) returning group_id,invite_code",[a]))[0];
      g=row.group_id;code=row.invite_code;
    } finally { await su(); }
    return !!g && !!code && !!friend;
  });
  await check('COMMON-03: nonmember cannot read or modify rule',async()=>{
    const denied=await rule(d,g);
    return denied.status==='NOT_FOUND' && (await save(d,g,uid(99))).status==='NOT_FOUND';
  });
  await check('COMMON-04: rule may be saved with one member and all fields',async()=>{
    first=await rule(a,g);
    const r=await save(a,g,first.version);
    version=r.version;
    return r.status==='OK' && r.accepted===true && r.viewAlarm && r.editAlarm && r.viewWake && r.viewTrip;
  });
  await check('COMMON-05: join with exact current rule and symmetric grants',async()=>{
    const pre=await call(b,'public.get_common_group_rule(null,$1)',[code]);
    const joined=await call(b,'public.join_group_with_rule($1,null,$2)',[pre.version,code]);
    const [n]=await q("select count(*)::int n from public.sharing_permissions where source_id=$1 and source_type='GROUP' and can_view_alarm and can_edit_alarm",[g]);
    const rows=await q("select wake_share_opt_in,trip_share_opt_in from public.group_members where group_id=$1 and invite_status='JOINED'",[g]);
    return joined.status==='JOINED' && n.n===2 && rows.length===2 && rows.every(x=>x.wake_share_opt_in&&x.trip_share_opt_in);
  });
  await check('COMMON-06: friend source can only grant wake; group grants still work',async()=>{
    await as(a);
    try {
      await q("insert into public.sharing_permissions(owner_id,grantee_id,source_type,source_id,can_view_alarm,can_edit_alarm,can_view_wake) values($1,$2,'FRIEND',$3,true,true,true) on conflict(owner_id,grantee_id,source_type,source_id) do update set can_view_alarm=true,can_edit_alarm=true,can_view_wake=true",[a,b,friend]);
    } finally { await su(); }
    const [f]=await q("select can_view_alarm,can_edit_alarm,can_view_wake from public.sharing_permissions where source_id=$1 and owner_id=$2",[friend,a]);
    const [allowed]=await q("select $2::uuid in (select private.granted_owner_ids_for($1,'EDIT_ALARM')) ok",[b,a]);
    const wake=await call(b,'public.get_friend_wake($1)',[a]);
    return !f.can_view_alarm&&!f.can_edit_alarm&&f.can_view_wake&&allowed.ok&&wake.status!=='NOT_SHARED';
  });
  await check('COMMON-07: member cannot directly change group grant or trip consent',async()=>{
    await as(b);
    try {
      const err=await expectErr(()=>q("update public.group_members set trip_share_opt_in=false where group_id=$1 and user_id=$2",[g,b]),/Use group rule consent/);
      const grant=await expectErr(()=>q("update public.sharing_permissions set can_edit_alarm=false where source_id=$1 and owner_id=$2",[g,b]),/Use group rule consent/);
      return err===true&&grant===true;
    } finally { await su(); }
  });
  await check('COMMON-08: changed version invalidates stale consent and requires reviewed join',async()=>{
    second=await save(a,g,version,true,false,true,false);
    const [grants]=await q("select count(*)::int n from public.sharing_permissions where source_type='GROUP' and source_id=$1",[g]);
    const [member]=await q("select wake_share_opt_in,trip_share_opt_in from public.group_members where group_id=$1 and user_id=$2",[g,b]);
    await as(c);
    let rejected;
    try { rejected=await expectErr(()=>q('select public.join_group_with_rule($1,null,$2)',[version,code]),/RULE_CHANGED/); }
    finally { await su(); }
    const [n]=await q("select count(*)::int n from public.group_members where group_id=$1 and user_id=$2 and invite_status='JOINED'",[g,c]);
    return second.version!==version&&grants.n===0&&!member.wake_share_opt_in&&!member.trip_share_opt_in&&rejected===true&&n.n===0;
  });
  await check('COMMON-09: accepted current rule is inherited by new member and existing member',async()=>{
    await save(b,g,second.version,true,false,true,false);
    const pre=await call(c,'public.get_common_group_rule(null,$1)',[code]);
    await call(c,'public.join_group_with_rule($1,null,$2)',[pre.version,code]);
    const [n]=await q("select count(*)::int n from public.sharing_permissions where source_type='GROUP' and source_id=$1 and can_view_alarm and not can_edit_alarm",[g]);
    const rows=await q("select wake_share_opt_in,trip_share_opt_in from public.group_members where group_id=$1 and invite_status='JOINED'",[g]);
    return n.n===6&&rows.length===3&&rows.every(x=>x.wake_share_opt_in&&!x.trip_share_opt_in);
  });
  await check('COMMON-10: withdrawing group consent revokes group access, preserves friend wake',async()=>{
    const r=await call(a,'public.withdraw_common_group_rule($1)',[g]);
    const [allowed]=await q("select $2::uuid in (select private.granted_owner_ids_for($1,'VIEW_ALARM')) ok",[b,a]);
    const wake=await call(b,'public.get_friend_wake($1)',[a]);
    return r.accepted===false&&!allowed.ok&&wake.status!=='NOT_SHARED';
  });
  await check('COMMON-11: anonymous access is denied',async()=>{
    await as(null,'anon');
    try { return await expectErr(()=>q('select public.get_friend_wake($1)',[a]),/permission denied/); }
    finally { await su(); }
  });
}
