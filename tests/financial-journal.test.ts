import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  financialPayload,
  decodeFinancialCommand,
  type FinancialCommand,
} from '../shared/financial-recovery.js';
import {
  readFinancialCommand,
  saveFinancialCommand,
  clearFinancialCommand,
  financialStorageKey,
} from '../web/financial-journal.js';
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  length = 0;
  clear() {
    this.data.clear();
    this.length = 0;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
    this.length = this.data.size;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
    this.length = this.data.size;
  }
}
const id = 'ad7b038d-d765-4bcd-a0ea-2c8e4f2f7c91';
const command: FinancialCommand = {
  version: 1,
  actorId: 'ops',
  url: `/api/cash/${id}/actions`,
  key: 'recovery-command-key',
  label: 'استلام عهدة نقدية',
  createdAt: 1,
  body: JSON.stringify({
    action: 'receive',
    expectedVersion: 2,
    amountMinor: 22000000,
    currency: 'SYP',
    reference: '  إيصال أصلي  ',
    reason: '  عد كامل النقد  ',
  }),
};
test('saved command is strict, actor bound and limited to known relative financial routes without changing its original request bytes', () => {
  const p = financialPayload(command.url, command.body);
  assert.equal(p.reference, 'إيصال أصلي');
  assert.deepEqual(decodeFinancialCommand(JSON.stringify(command), 'ops'), command);
  for (const url of [
    'https://example.org/api/payouts',
    '/api/session',
    '/api/payouts?extra=1',
    '/api/payouts/../actions',
  ])
    assert.throws(() => financialPayload(url, command.body));
  assert.throws(() => decodeFinancialCommand(JSON.stringify(command), 'merchant-a'));
  assert.throws(() =>
    financialPayload(
      command.url,
      JSON.stringify({ ...JSON.parse(command.body), merchantId: 'foreign' }),
    ),
  );
  assert.throws(() =>
    financialPayload(
      command.url,
      JSON.stringify({ ...JSON.parse(command.body), amountMinor: 1.2 }),
    ),
  );
  assert.throws(() =>
    financialPayload(
      command.url,
      JSON.stringify({ ...JSON.parse(command.body), action: 'invented' }),
    ),
  );
});
test('one saved financial command per actor survives re-reading and cannot be overwritten by a different cash or payout command', () => {
  const storage = new MemoryStorage();
  saveFinancialCommand(command, storage);
  assert.deepEqual(readFinancialCommand('ops', storage), command);
  const other = { ...command, actorId: 'merchant-a' };
  saveFinancialCommand(other, storage);
  assert.equal(readFinancialCommand('merchant-a', storage)?.key, other.key);
  assert.deepEqual(saveFinancialCommand({ ...command, createdAt: Date.now() }, storage), command);
  assert.throws(() => saveFinancialCommand({ ...command, key: 'new-key-for-command' }, storage));
  assert.throws(() =>
    clearFinancialCommand({ ...command, body: command.body.replace('22000000', '1') }, storage),
  );
  assert.deepEqual(readFinancialCommand('ops', storage), command);
  clearFinancialCommand(command, storage);
  assert.equal(readFinancialCommand('ops', storage), null);
  assert.deepEqual(readFinancialCommand('merchant-a', storage), other);
});
test('corrupted or unavailable storage blocks command preparation and preserves an existing uncertain record', () => {
  const storage = new MemoryStorage();
  storage.setItem(financialStorageKey('ops'), '{broken');
  assert.throws(() => readFinancialCommand('ops', storage));
  assert.throws(() => saveFinancialCommand(command, storage));
  assert.equal(storage.getItem(financialStorageKey('ops')), '{broken');
  const quota = new MemoryStorage();
  quota.setItem = () => {
    throw new Error('quota');
  };
  assert.throws(() => saveFinancialCommand(command, quota));
  const silent = new MemoryStorage();
  silent.setItem = () => {};
  assert.throws(() => saveFinancialCommand(command, silent));
});
