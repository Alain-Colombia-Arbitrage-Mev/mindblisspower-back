import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Actual SQL capabilities under the application role. No provider, signature,
 * signer, API key, production environment or network connection is involved. */
export async function runOwnershipAmountProbes({container,docker,psql,value,role,database}) {
 let probes=0;
 const eq=(sql,expected,runtime=true)=>{assert.equal(value(sql,runtime),expected);probes++;};
 const deny=(sql,code,runtime=true)=>{const result=psql(`${runtime?`SET ROLE ${role};`:''}${sql}`,true);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(code));probes++;};
 assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');
 assert.match(container,/^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
 assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
 psql(await readFile(new URL('../_meta/migration/106_personal_polygon_funding.sql',import.meta.url),'utf8'));
 const users=[['security-owner','0x8912345678901234567890123456789012345678'],['security-other','0x8912345678901234567890123456789012345679']];
 psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(([owner])=>`('${owner}',true,'${owner}@example.invalid','Synthetic security fixture')`).join(',')};
  INSERT INTO identity.wallet_binding(subject,address) VALUES ${users.map(([owner,address])=>`('${owner}','${address}')`).join(',')};`);
 const [owner,wallet]=users[0],[other,otherWallet]=users[1],id=randomUUID(),otherId=randomUUID();
 const amount='120000000',otherAmount='90000000',aa='0xcd12345678901234567890123456789012345678';
 const entry='0x0000000071727de22e5e9d8baf0edac6f37da032',implementation='0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229';
 const hash=text=>`0x${createHash('sha256').update(`synthetic-security:${text}`).digest('hex')}`;
 const cipher=`v1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`,newCipher=cipher.replace('a'.repeat(16),'d'.repeat(16));
 const prepare=(subject=owner,address=wallet,payment=id,atomic=amount,nonce='0',digest=hash(payment))=>`SELECT status FROM payments.prepare_personal_polygon_relay(
  '${subject}','${address}','${atomic}','${payment}','${nonce}','${digest}','${aa}','${entry}','${hash('domain')}','${implementation}','100','1000','10000000000000000000');`;
 const authorize=(subject=owner,payment=id,digest=hash(payment),blob=cipher)=>`SELECT status FROM payments.authorize_personal_polygon_relay('${subject}','${payment}','${digest}','${blob}','v1');`;
 const begin=(subject,payment,attempt,nonce)=>`SELECT should_prepare FROM payments.begin_personal_polygon_relay('${subject}','${payment}','${attempt}','${nonce}');`;
 const persist=(subject,payment,attempt,lease,op,until,blob=cipher)=>`SELECT should_send FROM payments.persist_personal_polygon_relay_operation(
  '${subject}','${payment}','${attempt}','${lease}','${op}','${blob}','v1',0,${until},'80');`;
 const release=(subject,payment,attempt,lease)=>`SELECT status FROM payments.release_personal_polygon_relay_attempt('${subject}','${payment}','${attempt}','${lease}','quote_unavailable');`;
 const stored=()=>value(`SELECT md5(to_jsonb(p)::text) FROM payments.personal_polygon_relay p WHERE id='${id}';`,false);
 const snapshot=`SELECT md5(jsonb_build_array(subject,wallet_address,amount_atomic,chain_id,token_address,recipient_address,
  authorization_nonce,authorization_digest,domain_separator,entry_point,relayer_address,max_fee_wei,owner_daily_cap_wei,global_daily_cap_wei)::text)
  FROM payments.personal_polygon_relay WHERE id='${id}';`;
 const otherFinancial=`SELECT md5(jsonb_build_object('ledger',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.wallet_movement m),
  'meld',(SELECT jsonb_agg(m ORDER BY id) FROM payments.meld_onramp_attempt m),'admin',(SELECT jsonb_agg(m ORDER BY id) FROM payments.meld_sandbox_funding_attempt m),
  'funding',(SELECT jsonb_agg(m ORDER BY id) FROM payments.reown_funding_intent m),'catalogue',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.package m))::text);`;
 const financialBefore=value(otherFinancial,false);
 const originalRelayRows=`SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'')) FROM payments.personal_polygon_relay p WHERE p.subject NOT IN('${owner}','${other}');`;
 const relayBefore=value(originalRelayRows,false);
 eq(prepare(),'prepared');eq(prepare(other,otherWallet,otherId,otherAmount),'prepared');
 const originalSnapshot=value(snapshot,false),preparedState=stored();
 deny(prepare(other,wallet),'company_payment_forbidden');
 deny(prepare(owner,otherWallet),'company_payment_forbidden');
 deny(prepare(other,otherWallet,id),'polygon_relay_request_already_used');
 deny(prepare(owner,wallet,id,'120000001'),'polygon_relay_request_already_used');
 deny(`SELECT * FROM payments.read_personal_polygon_relay('${other}','${id}');`,'polygon_relay_not_found');
 deny(authorize(other,id),'polygon_relay_not_found');
 deny(`SELECT * FROM payments.abandon_personal_polygon_relay('${other}','${id}');`,'polygon_relay_not_found');
 deny(`SELECT * FROM payments.read_personal_polygon_relay_activity('${other}','${id}',NULL,51);`,'polygon_relay_not_found');
 eq(`SELECT count(*) FROM payments.read_personal_polygon_relay_history('${other}') WHERE id='${id}';`,'0');
 eq(`SELECT bool_and(subject='${other}' AND wallet_address='${otherWallet}' AND amount_atomic='${otherAmount}') FROM payments.read_personal_polygon_relay_history('${other}');`,'t');
 eq(`SELECT md5(to_jsonb(p)::text) FROM payments.personal_polygon_relay p WHERE id='${id}';`,preparedState,false);
 eq(authorize(),'authorized');
 const authorizationSnapshot=`SELECT md5(jsonb_build_array(authorized_at,authorization_digest,authorization_ciphertext,authorization_key_id)::text)
  FROM payments.personal_polygon_relay WHERE id='${id}';`;
 const authorizationBefore=value(authorizationSnapshot,false);
 eq(authorize(owner,id,hash(id),newCipher),'authorized');
 eq(authorizationSnapshot,authorizationBefore,false);
 deny(authorize(owner,id,hash('changed-amount')),'polygon_relay_authorization_conflict');
 deny(authorize(other,otherId,hash(id)),'polygon_relay_authorization_conflict');
 deny(prepare(owner,wallet,id,'120000001'),'polygon_relay_request_already_used');
 for(const assignment of ["amount_atomic='1'",`subject='${other}'`,`wallet_address='${otherWallet}'`,
  `recipient_address='${otherWallet}'`,`authorization_digest='${hash('changed-amount')}'`]) {
  deny(`UPDATE payments.personal_polygon_relay SET ${assignment} WHERE id='${id}';`,'polygon_relay_snapshot_immutable',false);
 }
 deny(`UPDATE payments.personal_polygon_relay SET authorization_ciphertext='${newCipher}' WHERE id='${id}';`,'polygon_relay_authorization_immutable',false);
 const firstAttempt=randomUUID();
 deny(begin(other,id,firstAttempt,'0'),'polygon_relay_not_found');
 eq(begin(owner,id,firstAttempt,'0'),'t');
 const lease=value(`SELECT lease_token FROM payments.read_personal_polygon_relay('${owner}','${id}');`);
 deny(release(other,id,firstAttempt,lease),'polygon_relay_not_found');
 eq(release(owner,id,firstAttempt,lease),'authorized');
 eq(prepare(),'authorized');eq(snapshot,originalSnapshot,false);eq(authorizationSnapshot,authorizationBefore,false);
 deny(prepare(owner,wallet,id,'120000001'),'polygon_relay_request_already_used');
 const secondAttempt=randomUUID(),operation=hash('operation1:'+id),until=Math.floor(Date.now()/1000)+300;
 eq(begin(owner,id,secondAttempt,'0'),'t');
 const secondLease=value(`SELECT lease_token FROM payments.read_personal_polygon_relay('${owner}','${id}');`);
 deny(persist(other,id,secondAttempt,secondLease,operation,until),'polygon_relay_not_found');
 eq(persist(owner,id,secondAttempt,secondLease,operation,until),'t');
 eq(persist(owner,id,secondAttempt,secondLease,operation,until,newCipher),'f');
 eq(`SELECT operation_ciphertext FROM payments.personal_polygon_relay_operation WHERE attempt_id='${secondAttempt}';`,cipher,false);
 deny(persist(owner,id,secondAttempt,secondLease,hash('changed-operation'),until),'polygon_relay_operation_conflict');
 deny(release(owner,id,secondAttempt,secondLease),'polygon_relay_operation_locked');
 const tx=hash('reverted-transaction'),block=hash('canonical-block');
 const reject=(subject)=>`SELECT status FROM payments.reject_personal_polygon_relay('${subject}','${id}','${secondAttempt}','${operation}',
  '${tx}','130000001','${block}',12,'50','user_operation_reverted','0');`;
 deny(reject(other),'polygon_relay_not_found');eq(reject(owner),'authorized');
 eq(snapshot,originalSnapshot,false);eq(authorizationSnapshot,authorizationBefore,false);
 eq(`SELECT count(*) FROM payments.personal_polygon_native_authorization WHERE payment_id='${id}';`,'1',false);
 deny(prepare(owner,wallet,id,'120000001'),'polygon_relay_request_already_used');
 eq(prepare(),'authorized');eq(authorize(),'authorized');
 const thirdAttempt=randomUUID(),finalOperation=hash('operation2:'+id);
 eq(begin(owner,id,thirdAttempt,'1'),'t');
 const thirdLease=value(`SELECT lease_token FROM payments.read_personal_polygon_relay('${owner}','${id}');`);
 eq(persist(owner,id,thirdAttempt,thirdLease,finalOperation,until),'t');
 const finalTx=hash('confirmed-transaction');
 const confirm=(subject)=>`SELECT status FROM payments.confirm_personal_polygon_relay('${subject}','${id}','${thirdAttempt}','${finalOperation}',
  '${finalTx}','130000002','${block}',12,'50');`;
 deny(confirm(other),'polygon_relay_not_found');eq(confirm(owner),'confirmed');eq(confirm(owner),'confirmed');
 eq(prepare(),'confirmed');eq(snapshot,originalSnapshot,false);eq(authorizationSnapshot,authorizationBefore,false);
 deny(prepare(owner,wallet,id,'120000001'),'polygon_relay_request_already_used');
 deny(`UPDATE payments.personal_polygon_relay SET amount_atomic='120000001' WHERE id='${id}';`,'polygon_relay_snapshot_immutable',false);
 eq(`SELECT amount_atomic FROM payments.read_personal_polygon_relay('${owner}','${id}');`,amount);
 eq(`SELECT bool_and(subject='${owner}' AND wallet_address='${wallet}' AND amount_atomic='${amount}')
  FROM payments.read_personal_polygon_relay_activity('${owner}','${id}',NULL,51);`,'t');
 const victimEvent=value(`SELECT event_id FROM payments.personal_polygon_relay_event WHERE payment_id='${id}' ORDER BY seq LIMIT 1;`,false);
 deny(`SELECT * FROM payments.read_personal_polygon_relay_activity('${other}',NULL,'${victimEvent}',51);`,'polygon_relay_invalid_cursor');
 // The app role cannot reassign a binding. Privileged drift is simulated only
 // in this disposable fixture to verify an old payment never follows a new EOA.
 deny(`UPDATE identity.wallet_binding SET address='${otherWallet}' WHERE subject='${owner}';`,'permission denied');
 const changedId=randomUUID(),changedWallet='0x8912345678901234567890123456789012345680';
 eq(prepare(owner,wallet,changedId,'130000000','1'),'prepared');
 const beforeDrift=value(`SELECT md5(to_jsonb(p)::text) FROM payments.personal_polygon_relay p WHERE id='${changedId}';`,false);
 psql(`UPDATE identity.wallet_binding SET address='${changedWallet}' WHERE subject='${owner}';`);
 deny(authorize(owner,changedId),'company_payment_forbidden');
 deny(prepare(owner,wallet,changedId,'130000000','1'),'company_payment_forbidden');
 deny(prepare(owner,changedWallet,changedId,'130000000','1'),'polygon_relay_request_already_used');
 deny(`SELECT * FROM payments.read_personal_polygon_relay('${owner}','${id}');`,'company_payment_forbidden');
 eq(`SELECT count(*) FROM payments.read_personal_polygon_relay_history('${owner}');`,'0');
 eq(`SELECT md5(to_jsonb(p)::text) FROM payments.personal_polygon_relay p WHERE id='${changedId}';`,beforeDrift,false);
 psql(`UPDATE identity.wallet_binding SET address='${wallet}' WHERE subject='${owner}';`);
 eq(`SELECT status FROM payments.read_personal_polygon_relay('${owner}','${id}');`,'confirmed');
 eq(`SELECT status FROM payments.abandon_personal_polygon_relay('${owner}','${changedId}');`,'expired');
 eq(`SELECT status FROM payments.abandon_personal_polygon_relay('${other}','${otherId}');`,'expired');
 eq(otherFinancial,financialBefore,false);eq(originalRelayRows,relayBefore,false);
 console.log(JSON.stringify({ownershipAmountSqlSecurity:'passed',probes,subjects:2,stolenUuidRejected:true,
  preparedAuthorizedRetriedAndConfirmedAmountImmutable:true,acceptedAuthorizationNeverReplaced:true,
  foreignReceiptAndCursorRejected:true,bindingDriftNeverReassignsPayment:true,otherFinancialRowsUnchanged:true,
  environment:'disposable-postgres',externalNetwork:'disabled',productionConnections:0,realTransfers:0,actualCharges:0}));
}
