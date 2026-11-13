import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runNativeMemberProfileProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (q, expected, runtime = true) => { assert.equal(value(q,runtime),expected,q);probes++; };
  const deny = (q,code,runtime=true) => { const r=psql(`${runtime?`SET ROLE ${role};`:''}${q}`,true);assert.notEqual(r.status,0,q);assert.match(r.stderr,new RegExp(code),q);probes++; };
  const lit = x => `'${String(x).replaceAll("'","''")}'`;
  const hash=x=>createHash('sha256').update(x).digest('hex');
  assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');assert.equal(database,'mindbliss_curated_20261025');
  eq("SELECT to_regclass('payments.meld_checkout_intent') IS NULL;",'t',false);
  // A Git CRLF checkout must not change the already-applied114 dependency model.
  const applied114=await readFile(new URL('../_meta/migration/114_administrative_wallet_signing_dry_run.sql',import.meta.url),'utf8');
  const nativeGuard=applied114.replaceAll('\r\n','\n').match(/CREATE FUNCTION identity\.require_administrative_native_session\(p_subject text,p_session text\)[\s\S]*?END \$function\$;/)?.[0];assert.ok(nativeGuard);
  psql(nativeGuard.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  eq("SELECT md5(pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure));",'01bb63725c11ae353cb768a42ffa9485',false);
  // Disposable-only schema mirror for the authoritative identity/profile data.
  psql(`ALTER TABLE auth."user" ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z',
    ADD COLUMN IF NOT EXISTS phone_number text,ADD COLUMN IF NOT EXISTS phone_number_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS contact_phone_e164 text,ADD COLUMN IF NOT EXISTS contact_whatsapp_e164 text;
    CREATE TABLE IF NOT EXISTS mlm.person(id bigint PRIMARY KEY,public_id uuid NOT NULL,user_id text UNIQUE,email text,status text,blacklisted boolean NOT NULL DEFAULT false,birthday date,
      first_name text NOT NULL,last_name text NOT NULL,phone_number text NOT NULL,country text,payout_wallet_usdc text,is_admin boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z');
    CREATE TABLE IF NOT EXISTS identity.auth_binding(subject text PRIMARY KEY,provider text NOT NULL DEFAULT 'better_auth',person_id bigint NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS mlm.affiliate(id bigint PRIMARY KEY,person_id bigint NOT NULL,sponsor_id bigint,parent_id bigint,invitation_link text,status text NOT NULL DEFAULT 'active');
    ALTER TABLE mlm.person ADD COLUMN IF NOT EXISTS country text,ADD COLUMN IF NOT EXISTS payout_wallet_usdc text,
      ADD COLUMN IF NOT EXISTS birthday date,ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z';
    ALTER TABLE mlm.affiliate ADD COLUMN IF NOT EXISTS id bigint,ADD COLUMN IF NOT EXISTS sponsor_id bigint,ADD COLUMN IF NOT EXISTS parent_id bigint,ADD COLUMN IF NOT EXISTS invitation_link text;
    DO $$BEGIN IF(SELECT atttypid FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND NOT attisdropped)='bigint'::regtype THEN
      ALTER TABLE mlm.person ALTER COLUMN public_id TYPE uuid USING md5('profile-fixture-public:'||public_id::text)::uuid;
    END IF;END$$;
    CREATE TABLE IF NOT EXISTS mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;`);
  const normalization=await readFile(new URL('../_meta/migration/43_blacklist.sql',import.meta.url),'utf8');
  for(const name of ['norm_email','norm_phone10']){const definition=normalization.match(new RegExp(`CREATE OR REPLACE FUNCTION mlm\\.${name}\\([\\s\\S]*?\\$\\$;`))?.[0];assert.ok(definition);psql(definition);}
  psql(`CREATE OR REPLACE FUNCTION mlm.norm_name(p text)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT NULLIF(regexp_replace(lower(public.unaccent(btrim(coalesce(p,'')))),'\\s+',' ','g'),'')$$;`);
  // Use the EXACT real92 eligibility guard, not the funding harness's stub.
  const canonicalSource=await readFile(new URL('../_meta/migration/92_administrative_wallets_meld.sql',import.meta.url),'utf8');
  const canonicalGuard=canonicalSource.replaceAll('\r\n','\n').match(/CREATE FUNCTION identity\.administrative_wallet_person\(p_subject text\)[\s\S]*?END \$function\$;/)?.[0];assert.ok(canonicalGuard);
  psql(canonicalGuard.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  const users=Array.from({length:7},(_,i)=>({subject:`profile115-${i}`,session:`native-profile115-${i}`,alternate:`alternate-profile115-${i}`,person:11501+i}));
  psql(`INSERT INTO auth."user"(id,eligible,email,email_verified,name,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164)
    VALUES ${users.map((u,i)=>`('${u.subject}',true,'${u.subject}@example.invalid',true,'Old Display','+12025550101',true,'+12025550102','+12025550103')`).join(',')};
    INSERT INTO auth.session(id,user_id,expires_at)VALUES ${users.flatMap(u=>[u.session,u.alternate].map(s=>`('${s}','${u.subject}',clock_timestamp()+interval '2 days')`)).join(',')};
    INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number,country,payout_wallet_usdc)
    VALUES ${users.map(u=>`(${u.person},'${randomUUID()}','${u.subject}','${u.subject}@example.invalid','active','Old','Member','2025550123','Colombia','0x${'11'.repeat(20)}')`).join(',')};
    INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES ${users.map(u=>`('${u.subject}','better_auth',${u.person})`).join(',')};
    INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number,country)VALUES
    (11590,'${randomUUID()}',NULL,'sponsor115@example.invalid','active','Recruiting','Sponsor','','CO'),(11591,'${randomUUID()}',NULL,'parent115@example.invalid','active','Placement','Parent','','US');
    INSERT INTO mlm.affiliate(id,person_id,sponsor_id,parent_id,invitation_link)VALUES
    (115090,11590,NULL,NULL,'SPONSOR115'),(115091,11591,NULL,NULL,'PARENT115'),(115001,11501,115090,115091,'OWN115');`);
  const functionNames=['identity.read_member_profile(text,text)','identity.update_member_profile(text,text,text,text,text)'];
  const fnQ=`SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig)ORDER BY p.oid)::text,'')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm')AND p.proname NOT IN('read_member_profile','update_member_profile');`;
  const rowQueries=JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),''''))AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname)ORDER BY n.nspname,c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname NOT IN('pg_catalog','information_schema')AND n.nspname !~ '^pg_toast';`,false));
  const rowsQ=`SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest)ORDER BY name)::text FROM(${rowQueries.join(' UNION ALL ')})s;`;
  const before={rows:value(rowsQ,false),functions:value(fnQ,false),person:value('SELECT jsonb_agg(to_jsonb(p)ORDER BY id)::text FROM mlm.person p;',false),
    users:value('SELECT jsonb_agg(to_jsonb(u)ORDER BY id)::text FROM auth."user" u;',false),sessions:value('SELECT jsonb_agg(to_jsonb(s)ORDER BY id)::text FROM auth.session s;',false),
    bindings:value('SELECT jsonb_agg(to_jsonb(b)ORDER BY subject)::text FROM identity.auth_binding b;',false),
    owner:value("SELECT proowner FROM pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;",false)};
  const migration=await readFile(new URL('../_meta/migration/115_native_member_profile.sql',import.meta.url),'utf8');
  psql(migration);eq(rowsQ,before.rows,false);eq(fnQ,before.functions,false);
  const read=(i=0,session=users[i].session)=>`SELECT row_to_json(r)::text FROM identity.read_member_profile('${users[i].subject}','${session}')r;`;
  const write=(i=0,name='Ana Pérez',phone='+12025550123',country='CO',session=users[i].session)=>`SELECT row_to_json(r)::text FROM identity.update_member_profile('${users[i].subject}','${session}',${lit(name)},${lit(phone)},${country===null?'NULL':lit(country)})r;`;
  const initial=JSON.parse(value(read()));probes++;assert.deepEqual(initial,{first_name:'Old',last_name:'Member',phone:'2025550123',country:'Colombia',payout_wallet_usdc:`0x${'11'.repeat(20)}`,sponsor_name:'Recruiting Sponsor',sponsor_referral_code:'SPONSOR115',referral_code:'OWN115'});probes++;
  const noAffiliate=JSON.parse(value(read(1)));assert.equal(noAffiliate.sponsor_name,'');assert.equal(noAffiliate.sponsor_referral_code,'');assert.equal(noAffiliate.referral_code,'');probes++;
  const updated=JSON.parse(value(write()));assert.deepEqual(updated,{...initial,first_name:'Ana',last_name:'Pérez',phone:'+12025550123',country:'CO'});probes++;
  eq(`SELECT name||'|'||contact_phone_e164||'|'||phone_number||'|'||phone_number_verified::text||'|'||contact_whatsapp_e164 FROM auth."user" WHERE id='${users[0].subject}';`,'Ana Pérez|+12025550123|+12025550101|true|+12025550103',false);
  assert.deepEqual(JSON.parse(value(`SELECT (to_jsonb(p)-ARRAY['first_name','last_name','phone_number','country','updated_at'])::text FROM mlm.person p WHERE p.id=${users[0].person};`,false)),Object.fromEntries(Object.entries(JSON.parse(before.person).find(x=>x.id===users[0].person)).filter(([key])=>!['first_name','last_name','phone_number','country','updated_at'].includes(key))));probes++;
  const preserved=JSON.parse(value(write(1,'Single','',''+'')));assert.equal(preserved.first_name,'Single');assert.equal(preserved.last_name,'');assert.equal(preserved.phone,'');assert.equal(preserved.country,'');probes++;
  eq(`SELECT contact_phone_e164 IS NULL AND phone_number_verified AND phone_number='+12025550101' AND contact_whatsapp_e164='+12025550103' FROM auth."user" WHERE id='${users[1].subject}';`,'t',false);
  const legacy=JSON.parse(value(write(2,'Changed Display','+12025550104',null)));assert.equal(legacy.country,'Colombia');probes++;
  for(const name of ['José Núñez','D’Angelo O\'Brien','محمد عَلِي','王小明','आशा देवी','Алексей Иванов','A'.repeat(160),'  Ana   Pérez  ','Jose\u0301']){const row=JSON.parse(value(write(2,name,'+12025550104',null)));assert.equal([row.first_name,row.last_name].filter(Boolean).join(' '),name.normalize('NFC').trim().replace(/ +/g,' '));probes++;}
  for(const name of ['', '---','...','123','Ana123','<script>','Name;DROP TABLE','Name\\Surname','Name\nSurname','Name\tSurname','Name\u0085Surname','😀 Name','A'.repeat(161),'\u0301'])deny(write(2,name),'member_profile_invalid_request');
  for(const phone of ['1234567','+01234567','+123','+1234567890123456','+57 2025550123','+12025550123\n'])deny(write(2,'Valid Name',phone),'member_profile_invalid_request');
  for(const country of ['co','Colombia','COLOMBIA','C1','CO\n'])deny(write(2,'Valid Name','+12025550123',country),'member_profile_invalid_request');
  const policy=(columns,values)=>psql(`INSERT INTO mlm.blacklist(${columns})VALUES(${values});`);
  const clearPolicy=()=>psql('DELETE FROM mlm.blacklist;');
  for(const [columns,values]of [['email_norm',`'${users[2].subject}@example.invalid'`],['phone_last10',"mlm.norm_phone10('+12025550104')"],['name_norm','mlm.norm_name(\'José\')']]){
    policy(columns,values);deny(read(2),'member_profile_forbidden');deny(write(2,'Clean Name','+12025550122',null),'member_profile_forbidden');clearPolicy();
  }
  policy('phone_last10',"mlm.norm_phone10('+12025550166')");const beforeBlockedPhone=value(rowsQ,false);
  deny(write(2,'Allowed Name','+12025550166',null),'member_profile_forbidden');eq(rowsQ,beforeBlockedPhone,false);clearPolicy();
  policy('name_norm',"mlm.norm_name('Blocked Alias')");const beforeBlockedName=value(rowsQ,false);
  deny(write(2,'Blocked Alias','+12025550122',null),'member_profile_forbidden');eq(rowsQ,beforeBlockedName,false);clearPolicy();
  psql(`UPDATE mlm.person SET birthday='1990-01-01' WHERE id=${users[2].person};`);policy('name_norm,birthdate',"mlm.norm_name('José'),'2000-01-01'");eq(`SELECT count(*)FROM identity.read_member_profile('${users[2].subject}','${users[2].session}');`,'1');clearPolicy();
  policy('name_norm,birthdate',"mlm.norm_name('José'),'1990-01-01'");deny(read(2),'member_profile_forbidden');clearPolicy();psql(`UPDATE mlm.person SET birthday=NULL WHERE id=${users[2].person};`);
  psql(`INSERT INTO mlm.affiliate(id,person_id,status)VALUES(115203,${users[2].person},'banned');`);deny(read(2),'member_profile_forbidden');deny(write(2),'member_profile_forbidden');psql('DELETE FROM mlm.affiliate WHERE id=115203;');
  for(const i of [0,1]){deny(read(i,users[i+1].session),'member_profile_forbidden');deny(write(i,'Valid Name','+12025550123','CO',users[i+1].session),'member_profile_forbidden');}
  const stable=value(rowsQ,false);deny(write(2,'<script>'),'member_profile_invalid_request');eq(rowsQ,stable,false);
  psql(`UPDATE auth.session SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${users[3].session}';`);deny(read(3),'member_profile_forbidden');deny(write(3),'member_profile_forbidden');
  psql(`DELETE FROM auth.session WHERE id='${users[0].session}';`);deny(read(),'member_profile_forbidden');deny(write(),'member_profile_forbidden');eq(`SELECT count(*) FROM identity.read_member_profile('${users[0].subject}','${users[0].alternate}');`,'1');
  psql(`DELETE FROM identity.auth_binding WHERE subject='${users[4].subject}';`);deny(read(4),'member_profile_forbidden');
  psql(`UPDATE identity.auth_binding SET provider='oauth_untrusted' WHERE subject='${users[5].subject}';`);deny(read(5),'member_profile_forbidden');
  psql(`UPDATE mlm.person SET user_id='another-native-owner' WHERE id=${users[6].person};`);deny(read(6),'member_profile_forbidden');
  psql(`INSERT INTO mlm.affiliate(id,person_id,invitation_link)VALUES(115002,11501,'DUPLICATE115');`);deny(read(0,users[0].alternate),'member_profile_forbidden');
  deny(write(0,'Valid Name','+12025550123','CO',users[0].alternate),'member_profile_forbidden');psql('DELETE FROM mlm.affiliate WHERE id=115002;');
  const race=await Promise.all([parallelPsql(write(1,'First Concurrent','+12025550105','MX')),parallelPsql(write(1,'Second Concurrent','+12025550106','US',users[1].alternate))]);assert.ok(race.every(x=>x.status===0));probes++;
  eq(`SELECT u.name=btrim(p.first_name||' '||p.last_name) AND u.contact_phone_e164=p.phone_number FROM auth."user" u JOIN mlm.person p ON p.user_id=u.id WHERE u.id='${users[1].subject}';`,'t',false);
  // Restore synthetic target rows only, then prove every original table digest unchanged.
  psql(`TRUNCATE identity.auth_binding;INSERT INTO identity.auth_binding SELECT * FROM jsonb_populate_recordset(NULL::identity.auth_binding,${lit(before.bindings)}::jsonb);
    UPDATE mlm.person p SET user_id=j.user_id,first_name=j.first_name,last_name=j.last_name,phone_number=j.phone_number,country=j.country,updated_at=j.updated_at
    FROM jsonb_populate_recordset(NULL::mlm.person,${lit(before.person)}::jsonb)j WHERE p.id=j.id;
    UPDATE auth."user" u SET name=j.name,contact_phone_e164=j.contact_phone_e164,updated_at=j.updated_at FROM jsonb_populate_recordset(NULL::auth."user",${lit(before.users)}::jsonb)j WHERE u.id=j.id;
    TRUNCATE auth.session;INSERT INTO auth.session SELECT * FROM jsonb_populate_recordset(NULL::auth.session,${lit(before.sessions)}::jsonb);`);
  eq(rowsQ,before.rows,false);eq(fnQ,before.functions,false);deny(migration,'member_profile_requires_fresh_review',false);
  for(const name of functionNames){eq(`SELECT has_function_privilege('${role}','${name}','EXECUTE');`,'t',false);eq(`SELECT has_function_privilege('sandbox_fixture_default','${name}','EXECUTE');`,'f',false);}
  deny(`UPDATE mlm.person SET is_admin=true;`,'permission denied');
  const functions=functionNames.map(name=>JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'prosecdef',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl,'runtimeExecute',true)::text FROM pg_proc p WHERE oid='${name}'::regprocedure;`,false)));
  for(const f of functions){assert.equal(f.owner,before.owner);assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);probes++;}
  await writeFile(new URL('../.wrangler/native-member-profile-115-manifest.json',import.meta.url),JSON.stringify({migrationSha256:hash(migration),syntheticPostgresPassed:true,
    functions:functions.map(f=>({...f,ownerReferenceSignature:'identity.require_administrative_native_session(text,text)'})),tables:[],constraints:[],changedFunctions:[],probes,
    canonicalIdentityGuard:JSON.parse(value("SELECT jsonb_build_object('signature','identity.administrative_wallet_person(text)','md5',md5(pg_get_functiondef('identity.administrative_wallet_person(text)'::regprocedure)))::text;",false)),
    existingRowsUnchanged:true,oldFunctionsAndFinancialRowsUnchanged:true,profileUpdatesSyntheticOnly:true,productionConnections:0,actualCharges:0,broadcasts:0,externalNetwork:'disabled',independentOfMigration113:true},null,2));
  console.log(JSON.stringify({nativeMemberProfileSchema:'passed',probes,ownedNativeSession:true,atomicDisplayAndContactOnly:true,readonlySponsorNotPlacementParent:true,
    oldRowsAndFunctionsUnchanged:true,productionConnections:0,actualCharges:0}));
}
