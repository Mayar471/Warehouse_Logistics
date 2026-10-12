import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account } from '../shared/contracts.js';
import { financialPayload, financialScope } from '../shared/financial-recovery.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, canonical, transactionGate } from './domain.js';

export function financialActor(req: FastifyRequest, a: Account) {
  assert(
    req.headers['x-financial-actor'] === undefined || req.headers['x-financial-actor'] === a.id,
    403,
    'ACCOUNT_CHANGED',
    'تغير حساب الجلسة؛ عد إلى حساب الإقرار الأصلي قبل متابعته',
  );
}
export function registerFinancialRecovery(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
) {
  app.post('/api/financial-commands/status', async (req) => {
    const a = account(req);
    financialActor(req, a);
    const b = z
      .object({
        url: z.string().max(150),
        body: z.string().max(4000),
        key: z.string().min(8).max(128),
      })
      .strict()
      .parse(req.body);
    let payload: Record<string, unknown>, scope: string;
    try {
      payload = financialPayload(b.url, b.body);
      scope = financialScope(a.id, b.url);
    } catch {
      assert(false, 422, 'INVALID_FINANCIAL_COMMAND', 'الإقرار المالي المحفوظ غير صالح');
    }
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    return write(async (tx) => {
      const row = (
        await tx.query<{ fingerprint: string }>(
          'SELECT fingerprint FROM idempotency WHERE scope=$1 AND key=$2',
          [scope, b.key],
        )
      ).rows[0];
      return {
        state: !row ? 'unknown' : row.fingerprint === fingerprint ? 'committed' : 'conflict',
      };
    });
  });
}
