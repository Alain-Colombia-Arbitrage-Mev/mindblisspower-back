import { nowpaymentsCaptureReady } from './routing.mjs';
import { containerEnvironment } from './runtime-env.mjs';
import { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';

const REQUIRED = Object.freeze(['PAYMENTS_DATABASE_URL', 'PAYMENTS_SERVICE_TOKEN', 'CORE_SUPER_ADMIN_EMAILS',
  'PAYMENTS_ROOT_AFFILIATE_ID', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'NOWPAYMENTS_WEBHOOK_DATABASE_URL',
  'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET']);
const ERRORS = Object.freeze({
  'Core service secrets are incomplete': 'INCOMPLETE_BINDINGS',
  'Invalid service database configuration': 'INVALID_DATABASE_CONFIGURATION',
  'NOWPayments capture configuration is incomplete': 'CAPTURE_CONFIGURATION_INCOMPLETE',
  'NOWPayments capture database isolation is not configured': 'DATABASE_ISOLATION_INVALID',
  'NOWPayments operational configuration is incomplete': 'OPERATIONAL_CONFIGURATION_INCOMPLETE',
  'NOWPayments operational database isolation is not configured': 'OPERATIONAL_DATABASE_ISOLATION_INVALID',
  'Invalid core service configuration': 'INVALID_CORE_CONFIGURATION',
});
const empty = () => ({ requiredBindingsPresent: false, readWriteHostEqual: false, readWritePortEqual: false,
  readWriteDatabaseEqual: false, readWriteUserDifferent: false, readTlsVerifyFull: false, writeTlsVerifyFull: false,
  writerPresent: false, writerReaderHostEqual: false, writerReaderPortEqual: false, writerReaderDatabaseEqual: false,
  writerReaderBranchSuffixSame: false, writerUsersDifferent: false, writerTlsVerifyFull: false,
  branchSuffixSame: false, runtimeMappingValid: false, errorEnum: 'DIAGNOSTICS_DISABLED', readerTarget: null });

function database(value) {
  try {
    if (typeof value !== 'string' || !value) return null;
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    const user = decodeURIComponent(url.username);
    const suffix = user.includes('.') ? user.slice(user.indexOf('.') + 1) : '';
    return { host: url.hostname, port: url.port || '5432', database: url.pathname, user, suffix,
      tls: url.searchParams.get('sslmode') === 'verify-full' };
  } catch { return null; }
}

/** Zero-argument private RPC projection only: no values, lengths or fingerprints. */
export function captureConfiguration(env) {
  const result = empty();
  if (!nowpaymentsCaptureReady(env)) return result;
  try {
    result.requiredBindingsPresent = REQUIRED.every(key => typeof env[key] === 'string' && Boolean(env[key].trim()));
    const read = database(env.PAYMENTS_DATABASE_URL), write = database(env.NOWPAYMENTS_WEBHOOK_DATABASE_URL);
    // Operator-approved non-secret routing metadata only. Never expose the
    // username (which contains the branch), password, query or complete DSN.
    result.readerTarget = read ? {
      host: /^[a-z0-9.-]{1,253}\.psdb\.cloud$/.test(read.host) ? read.host : 'redacted',
      port: Number(read.port),
      database: read.database === '/mindbliss_curated_20261025' ? 'mindbliss_curated_20261025' : 'redacted',
    } : null;
    result.readTlsVerifyFull = read?.tls === true;
    result.writeTlsVerifyFull = write?.tls === true;
    if (read && write) {
      result.readWriteHostEqual = read.host === write.host;
      result.readWritePortEqual = read.port === write.port;
      result.readWriteDatabaseEqual = read.database === write.database;
      result.readWriteUserDifferent = read.user !== write.user;
      result.branchSuffixSame = Boolean(read.suffix && write.suffix && read.suffix === write.suffix);
    }
    if (nowpaymentsOperationalReady(env)) {
      result.writerPresent = typeof env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL === 'string' && Boolean(env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.trim());
      const writer = database(env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL);
      result.writerTlsVerifyFull = writer?.tls === true;
      if (read && writer) {
        result.writerReaderHostEqual = read.host === writer.host;
        result.writerReaderPortEqual = read.port === writer.port;
        result.writerReaderDatabaseEqual = read.database === writer.database;
        result.writerReaderBranchSuffixSame = Boolean(read.suffix && writer.suffix && read.suffix === writer.suffix);
        result.writerUsersDifferent = Boolean(write && writer.user !== read.user && writer.user !== write.user);
      }
    }
    containerEnvironment('payments', env);
    result.runtimeMappingValid = true;
    result.errorEnum = 'NONE';
  } catch (error) {
    result.errorEnum = Object.hasOwn(ERRORS, error?.message) ? ERRORS[error.message] : 'UNEXPECTED_CONFIGURATION_ERROR';
  }
  return result;
}
