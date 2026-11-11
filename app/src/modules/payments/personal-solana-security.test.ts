import { expect, test } from 'bun:test';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { solanaWalletLinkMessage, verifySolanaWalletProof } from '../identity/solana-wallet-link';
import { buildPersonalSolanaTransaction, verifyPersonalSolanaSignedTransaction } from './personal-solana-transaction';
import { canonicalSolanaAddress, canonicalBase64Bytes, SOLANA_GENESIS_HASH, SOLANA_USDT_MINT, SOLANA_TOKEN_PROGRAM } from './personal-solana-policy';
import { createPimlicoSolanaClient, personalSolanaCapabilities, solanaSponsorPolicy } from './pimlico-solana';
import { createSolanaReadRpc, readSolanaUsdtSnapshot } from './personal-solana-rpc';
import { solanaJsonRequest } from './solana-json-transport';
const owner = Keypair.fromSeed(new Uint8Array(32).fill(7)), payer = Keypair.fromSeed(new Uint8Array(32).fill(8));
const template = { walletAddress: owner.publicKey.toBase58(), feePayerAddress: payer.publicKey.toBase58(), amountAtomic: '30000000',
  blockhash: Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(), lastValidBlockHeight: '1000' };
const environment = { PERSONAL_SOLANA_ENABLED: 'true', PERSONAL_SOLANA_PREPARE_ENABLED: 'true', REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-pimlico-test-secret' };

test('Solana ownership verifies exact UTF8 Ed25519 messages and rejects EVM, replayed message and small-order public key forgery', () => {
  const message = solanaWalletLinkMessage({ origin: 'https://app.mindblisspower.com', address: template.walletAddress,
    challengeId: '11111111-1111-4111-8111-111111111111', nonce: 'a'.repeat(64), issuedAt: new Date('2026-11-11T04:00:00Z'), expiresAt: new Date('2026-11-11T04:05:00Z') });
  const signature = Buffer.from(ed25519.sign(Buffer.from(message), owner.secretKey.slice(0, 32))).toString('base64');
  expect(verifySolanaWalletProof(message, signature, template.walletAddress)).toBe(true);
  expect(message).toContain(SOLANA_GENESIS_HASH); expect(message).toContain('does not sign in');
  expect(verifySolanaWalletProof(message + 'changed', signature, template.walletAddress)).toBe(false);
  expect(verifySolanaWalletProof(message, signature, template.feePayerAddress)).toBe(false);
  expect(verifySolanaWalletProof(message, `0x${'a'.repeat(130)}`, template.walletAddress)).toBe(false);
  expect(() => canonicalSolanaAddress(`0x${'1'.repeat(40)}`, true)).toThrow();
  const identityKey = new Uint8Array(32); identityKey[0] = 1;
  const forged = new Uint8Array(64); forged[0] = 1;
  expect(PublicKey.isOnCurve(identityKey)).toBe(true);
  expect(() => canonicalSolanaAddress(new PublicKey(identityKey).toBase58(), true)).toThrow('invalid_wallet_address');
  expect(verifySolanaWalletProof('arbitrary challenge', Buffer.from(forged).toString('base64'), new PublicKey(identityKey).toBase58())).toBe(false);
});

test('immutable legacy transaction template permits only exact owner partial signature and exact sponsor co-signature', () => {
  const prepared = buildPersonalSolanaTransaction(template), transaction = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
  transaction.partialSign(owner);
  const partial = transaction.serialize({ requireAllSignatures: false }).toString('base64');
  expect(verifyPersonalSolanaSignedTransaction({ ...template, messageHash: prepared.messageHash }, partial)).toMatchObject({ messageHash: prepared.messageHash, transactionSignature: null });
  transaction.partialSign(payer);
  const signed = transaction.serialize().toString('base64');
  expect(verifyPersonalSolanaSignedTransaction({ ...template, messageHash: prepared.messageHash }, signed, true).transactionSignature).toBeTruthy();
  expect(() => verifyPersonalSolanaSignedTransaction({ ...template, messageHash: prepared.messageHash }, signed)).toThrow('solana_payment_invalid_transaction');
  expect(() => verifyPersonalSolanaSignedTransaction({ ...template, messageHash: prepared.messageHash }, prepared.transactionBase64)).toThrow('solana_payment_signature_invalid');
});

test('signed Solana messages cannot hide instructions, change payer/amount, use versioned/ALT messages or malformed base64', () => {
  const prepared = buildPersonalSolanaTransaction(template), expected = { ...template, messageHash: prepared.messageHash };
  for (const changed of [() => {
    const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
    tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: payer.publicKey, lamports: 1 })); tx.partialSign(owner);
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }, () => {
    const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
    tx.instructions[1]!.data[1] = tx.instructions[1]!.data[1]! ^ 1; tx.partialSign(owner);
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }, () => {
    const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: template.blockhash, instructions: tx.instructions }).compileToV0Message();
    const versioned = new VersionedTransaction(message); versioned.sign([owner]); return Buffer.from(versioned.serialize()).toString('base64');
  }]) expect(() => verifyPersonalSolanaSignedTransaction(expected, changed())).toThrow('solana_payment_invalid_transaction');
  for (const raw of [prepared.transactionBase64 + '\n', '%%%=', Buffer.alloc(1233).toString('base64')]) expect(() => canonicalBase64Bytes(raw, 1232)).toThrow();
  expect(() => verifyPersonalSolanaSignedTransaction({ ...expected, amountAtomic: '30000001' }, prepared.transactionBase64)).toThrow('solana_payment_invalid_transaction');
});

test('Pimlico uses only fixed mainnet endpoint, server Bearer, bounded fee and never broadcasts without an explicit gate', async () => {
  const seen: string[] = [], fetchImpl = (async (url, init) => {
    expect(String(url)).toBe('https://solana.pimlico.io/v1/mainnet/rpc'); expect(String(url)).not.toContain(environment.PIMLICO_API_KEY);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${environment.PIMLICO_API_KEY}`);
    const body = JSON.parse(String(init?.body)); seen.push(body.method);
    const result = body.method === 'getPayerSigner' ? { signer_address: template.feePayerAddress, payment_address: template.feePayerAddress }
      : body.method === 'getSupportedTokens' ? { tokens: [SOLANA_USDT_MINT] }
      : { fee_in_lamports: 2_050_000, signer_pubkey: template.feePayerAddress };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  }) as typeof fetch;
  const client = createPimlicoSolanaClient(environment, fetchImpl), plan = buildPersonalSolanaTransaction(template);
  expect(await client.getPayerSigner()).toMatchObject({ feePayerAddress: template.feePayerAddress });
  expect(await client.getSupportedTokens()).toEqual({ usdtSupported: true });
  expect(await client.estimateTransactionFee(plan.transactionBase64, template.feePayerAddress)).toMatchObject({ feeLamports: '2050000' });
  await expect(client.signAndSendTransaction(plan.transactionBase64, template.feePayerAddress)).rejects.toThrow('solana_payment_broadcast_disabled');
  expect(seen).toEqual(['getPayerSigner', 'getSupportedTokens', 'estimateTransactionFee']);
  expect(personalSolanaCapabilities(environment).transferEnabled).toBe(false);
  expect(personalSolanaCapabilities({ ...environment, PERSONAL_SOLANA_BROADCAST_ENABLED: 'true' })).toMatchObject({ transferEnabled: true, sponsorship: 'mindbliss' });
  expect(solanaSponsorPolicy(environment)).toEqual({ maxFeeLamports: '3000000', ownerDailyCapLamports: '6000000', globalDailyCapLamports: '30000000' });
  expect(personalSolanaCapabilities({ ...environment, PERSONAL_SOLANA_BROADCAST_ENABLED: 'true', PERSONAL_SOLANA_MAX_FEE_LAMPORTS: '100000001' }).transferEnabled).toBe(false);
});

test('RPC balance is mainnet fixed USDT and one derived ATA, with no arbitrary RPC or sender broadcast operation', async () => {
  const methods: string[] = [], fetchImpl = (async (url, init) => {
    expect(String(url)).toContain('chainId=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp&');
    const body = JSON.parse(String(init?.body)); methods.push(body.method);
    const result = body.method === 'getGenesisHash' ? SOLANA_GENESIS_HASH : body.method === 'getBalance' ? { value: 0 }
      : body.params[0] === SOLANA_USDT_MINT ? { value: { owner: SOLANA_TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6 } } } } }
      : { value: { owner: SOLANA_TOKEN_PROGRAM, data: { parsed: { type: 'account', info: { mint: SOLANA_USDT_MINT,
        owner: template.walletAddress, state: 'initialized', tokenAmount: { amount: '30000000', decimals: 6 } } } } } };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  }) as typeof fetch;
  const rpc = createSolanaReadRpc(environment, fetchImpl);
  expect(await readSolanaUsdtSnapshot(rpc, template.walletAddress)).toMatchObject({ scope: 'associated_token_account', balanceAtomic: '30000000', nativeBalanceAtomic: '0', tokenDecimals: 6 });
  await expect(rpc.call('sendTransaction' as never)).rejects.toThrow('solana_payment_rpc_unavailable');
  expect(methods.every(method => ['getGenesisHash', 'getAccountInfo', 'getBalance'].includes(method))).toBe(true);
});

test('bounded JSON-RPC transport times out a hung body and never exposes upstream private details', async () => {
  const started = Date.now();
  await expect(solanaJsonRequest('https://example.invalid', {}, { timeoutMs: 15,
    fetchImpl: (async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  })).rejects.toThrow('solana_payment_rpc_unavailable');
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(solanaJsonRequest('https://example.invalid', {}, { fetchImpl: (async () => { throw Error('secret upstream key'); }) as unknown as typeof fetch }))
    .rejects.toThrow('solana_payment_rpc_unavailable');
});
