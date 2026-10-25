import { db } from '../../db/client';
import { ledgerClient } from '../../clients/engine';
import { createLedgerCommands } from './commands';

export const { postTransaction, registerPvCredit } = createLedgerCommands({ database: db, ledger: ledgerClient });
