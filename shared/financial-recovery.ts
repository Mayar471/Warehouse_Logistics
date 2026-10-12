export interface FinancialCommand {
  version: 1;
  actorId: string;
  url: string;
  body: string;
  key: string;
  label: string;
  createdAt: number;
}
export interface FinancialResult {
  state: 'committed' | 'unknown' | 'conflict';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cashActions = new Set([
  'receive',
  'report_difference',
  'return_request',
  'return_release',
  'return_confirm',
  'return_cancel',
  'return_difference',
]);
const payoutActions = new Set([
  'release',
  'confirm',
  'cancel',
  'report_issue',
  'request_return',
  'receive_return',
  'request_recovery',
  'receive_recovery',
]);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.trim().length >= min && v.length <= max;
const positive = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
export function financialPayload(url: string, body: string): Record<string, unknown> {
  if (body.length > 4000) throw new Error('INVALID_FINANCIAL_COMMAND');
  const p: unknown = JSON.parse(body);
  if (
    !object(p) ||
    !(typeof p.reference === 'string' && text(p.reference.trim(), 3, 100)) ||
    !(typeof p.reason === 'string' && text(p.reason.trim(), 3, 240))
  )
    throw new Error('INVALID_FINANCIAL_COMMAND');
  let allowed: string[];
  if (url === '/api/payouts') {
    if (
      typeof p.shipmentId !== 'string' ||
      !uuid.test(p.shipmentId) ||
      !positive(p.expectedCollectionVersion)
    )
      throw new Error('INVALID_FINANCIAL_COMMAND');
    allowed = ['shipmentId', 'expectedCollectionVersion', 'reference', 'reason'];
  } else {
    const match = /^\/api\/(cash|payouts|refunds)\/([^/]+)\/actions$/.exec(url);
    if (
      !match ||
      !uuid.test(match[2]) ||
      !positive(p.expectedVersion) ||
      typeof p.action !== 'string' ||
      !(
        match[1] === 'cash'
          ? cashActions
          : match[1] === 'refunds'
            ? new Set(['request', 'reserve', 'release', 'cancel'])
            : payoutActions
      ).has(p.action)
    )
      throw new Error('INVALID_FINANCIAL_COMMAND');
    const amount = match[1] !== 'payouts' || p.action !== 'cancel';
    allowed = [
      'action',
      'expectedVersion',
      'reference',
      'reason',
      ...(amount ? ['amountMinor', 'currency'] : []),
    ];
    if (
      amount &&
      (typeof p.amountMinor !== 'number' ||
        !Number.isSafeInteger(p.amountMinor) ||
        p.amountMinor < 0 ||
        p.amountMinor > 1000000000000 ||
        p.currency !== 'SYP')
    )
      throw new Error('INVALID_FINANCIAL_COMMAND');
  }
  if (Object.keys(p).length !== allowed.length || Object.keys(p).some((k) => !allowed.includes(k)))
    throw new Error('INVALID_FINANCIAL_COMMAND');
  return { ...p, reference: p.reference.trim(), reason: p.reason.trim() };
}
export function financialScope(actorId: string, url: string) {
  if (url === '/api/payouts') return `${actorId}:payout:create`;
  const match = /^\/api\/(cash|payouts|refunds)\/([^/]+)\/actions$/.exec(url);
  if (!match || !uuid.test(match[2])) throw new Error('INVALID_FINANCIAL_COMMAND');
  return `${actorId}:${match[1] === 'cash' ? 'cash' : match[1] === 'refunds' ? 'refund' : 'payout'}:${match[2]}`;
}
export function decodeFinancialCommand(raw: string, actorId: string): FinancialCommand {
  if (raw.length > 8000) throw new Error('INVALID_FINANCIAL_COMMAND');
  const c: unknown = JSON.parse(raw);
  if (
    !object(c) ||
    Object.keys(c).sort().join(',') !== 'actorId,body,createdAt,key,label,url,version' ||
    c.version !== 1 ||
    c.actorId !== actorId ||
    !text(c.actorId, 1, 40) ||
    typeof c.url !== 'string' ||
    typeof c.body !== 'string' ||
    !text(c.key, 8, 128) ||
    !text(c.label, 1, 80) ||
    !positiveTime(c.createdAt)
  )
    throw new Error('INVALID_FINANCIAL_COMMAND');
  financialPayload(c.url, c.body);
  return c as unknown as FinancialCommand;
}
function positiveTime(v: unknown) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
