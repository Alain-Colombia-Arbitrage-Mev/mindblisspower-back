import { createHash } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519';
import { encodeBase58 } from 'ethers';
import { canonicalBase64Bytes, canonicalSolanaAddress, SOLANA_COMPANY_RECIPIENT, SOLANA_COMPANY_TOKEN_ACCOUNT,
  SOLANA_MAX_TRANSACTION_BYTES, SOLANA_USDT_DECIMALS, SOLANA_USDT_MINT, solanaAtomic } from './personal-solana-policy';
import { solanaSourceTokenAccount } from './personal-solana-rpc';

export type SolanaPaymentTemplate = { walletAddress: string; feePayerAddress: string; amountAtomic: string; blockhash: string; lastValidBlockHeight: string };
export function buildPersonalSolanaTransaction(input: SolanaPaymentTemplate) {
  const sender = new PublicKey(canonicalSolanaAddress(input.walletAddress, true));
  const payer = new PublicKey(canonicalSolanaAddress(input.feePayerAddress, true));
  if (sender.equals(payer) || !solanaAtomic(input.amountAtomic) || !/^[1-9][0-9]{0,15}$/.test(input.lastValidBlockHeight)
    || !Number.isSafeInteger(Number(input.lastValidBlockHeight))) throw new Error('solana_payment_invalid_transaction');
  canonicalSolanaAddress(input.blockhash);
  const mint = new PublicKey(SOLANA_USDT_MINT), recipient = new PublicKey(SOLANA_COMPANY_RECIPIENT);
  const sourceTokenAccount = solanaSourceTokenAccount(sender.toBase58()), destination = getAssociatedTokenAddressSync(mint, recipient, false);
  if (destination.toBase58() !== SOLANA_COMPANY_TOKEN_ACCOUNT) throw new Error('solana_payment_unconfigured');
  const transaction = new Transaction({ feePayer: payer, blockhash: input.blockhash, lastValidBlockHeight: Number(input.lastValidBlockHeight) });
  transaction.add(createAssociatedTokenAccountIdempotentInstruction(payer, destination, recipient, mint),
    createTransferCheckedInstruction(new PublicKey(sourceTokenAccount), mint, destination, sender, BigInt(input.amountAtomic), SOLANA_USDT_DECIMALS));
  const message = transaction.serializeMessage(), bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > SOLANA_MAX_TRANSACTION_BYTES) throw new Error('solana_payment_invalid_transaction');
  return { transactionBase64: bytes.toString('base64'), messageHash: createHash('sha256').update(message).digest('hex'),
    sourceTokenAccount, destinationTokenAccount: destination.toBase58(), message };
}
function transactionBytes(raw: string) {
  try {
    const bytes = canonicalBase64Bytes(raw, SOLANA_MAX_TRANSACTION_BYTES), transaction = Transaction.from(bytes);
    if (!bytes.equals(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))) throw new Error();
    return transaction;
  } catch { throw new Error('solana_payment_invalid_transaction'); }
}
/** Equality with a freshly rebuilt immutable template rejects hidden instructions, ALTs,
 * changed fee payer/mint/recipient/amount, extra signers, nonces and added priority fees.
 */
export function verifyPersonalSolanaSignedTransaction(input: SolanaPaymentTemplate & { messageHash: string }, raw: string, fullySigned = false) {
  const template = buildPersonalSolanaTransaction(input), transaction = transactionBytes(raw), message = transaction.serializeMessage();
  if (template.messageHash !== input.messageHash || !template.message.equals(message) || transaction.signatures.length !== 2
    || transaction.signatures[0]!.publicKey.toBase58() !== input.feePayerAddress || transaction.signatures[1]!.publicKey.toBase58() !== input.walletAddress
    || (!fullySigned && transaction.signatures[0]!.signature !== null)) throw new Error('solana_payment_invalid_transaction');
  const required = fullySigned ? transaction.signatures : [transaction.signatures[1]!];
  for (const signer of required) {
    if (!signer.signature || signer.signature.length !== 64 || !ed25519.verify(signer.signature, message, signer.publicKey.toBytes(), { zip215: false })) throw new Error('solana_payment_signature_invalid');
  }
  const serialized = transaction.serialize({ requireAllSignatures: fullySigned, verifySignatures: false });
  return { transactionBase64: serialized.toString('base64'), serializedHash: createHash('sha256').update(serialized).digest('hex'),
    transactionSignature: fullySigned ? encodeBase58(transaction.signatures[0]!.signature!) : null,
    messageHash: input.messageHash, sourceTokenAccount: template.sourceTokenAccount, destinationTokenAccount: template.destinationTokenAccount };
}
