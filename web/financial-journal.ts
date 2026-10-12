import { api, ApiError } from './api.js';
import {
  decodeFinancialCommand,
  type FinancialCommand,
  type FinancialResult,
} from '../shared/financial-recovery.js';

export class FinancialJournalError extends Error {}
export const financialStorageKey = (actorId: string) =>
  `logistics:financial-command:v1:${encodeURIComponent(actorId)}`;
function storage(provided?: Storage) {
  return provided ?? window.localStorage;
}
export function readFinancialCommand(actorId: string, provided?: Storage): FinancialCommand | null {
  try {
    const raw = storage(provided).getItem(financialStorageKey(actorId));
    return raw === null ? null : decodeFinancialCommand(raw, actorId);
  } catch {
    throw new FinancialJournalError(
      'تعذر قراءة سجل الإقرار المحفوظ. لا ترسل إقرارًا جديدًا قبل استعادة سجله والتحقق من نتيجته.',
    );
  }
}
const same = (a: FinancialCommand, b: FinancialCommand) =>
  a.actorId === b.actorId && a.url === b.url && a.body === b.body && a.key === b.key;
export function saveFinancialCommand(
  command: FinancialCommand,
  provided?: Storage,
): FinancialCommand {
  try {
    const valid = decodeFinancialCommand(JSON.stringify(command), command.actorId);
    const old = readFinancialCommand(command.actorId, provided);
    if (old) {
      if (!same(old, valid))
        throw new FinancialJournalError(
          'يوجد إقرار مالي محفوظ لهذا الحساب. تابع نتيجته قبل إنشاء إقرار آخر.',
        );
      return old;
    }
    storage(provided).setItem(financialStorageKey(command.actorId), JSON.stringify(valid));
    const saved = readFinancialCommand(command.actorId, provided);
    if (!saved || !same(saved, valid)) throw new Error('Unconfirmed storage');
    return saved;
  } catch (e) {
    if (e instanceof FinancialJournalError) throw e;
    throw new FinancialJournalError(
      'تعذر حفظ سجل الاستعادة؛ لم يُرسل الإقرار. أعد المحاولة بعد إتاحة الحفظ في المتصفح.',
    );
  }
}
export function clearFinancialCommand(command: FinancialCommand, provided?: Storage) {
  const current = readFinancialCommand(command.actorId, provided);
  if (!current) return;
  if (!same(current, command))
    throw new FinancialJournalError('تغير الإقرار المحفوظ. حدّث سجل الاستعادة قبل المتابعة.');
  try {
    storage(provided).removeItem(financialStorageKey(command.actorId));
  } catch {
    throw new FinancialJournalError(
      'حُفظ الإقرار على الخادم، لكن تعذر إنهاء سجل استعادته. افحص نتيجته قبل إرسال أي إقرار آخر.',
    );
  }
  if (readFinancialCommand(command.actorId, provided))
    throw new FinancialJournalError('لم ينته سجل الاستعادة. افحص نتيجة الإقرار قبل المتابعة.');
}
export function retainedFinancialError(e: unknown) {
  return (
    !(e instanceof ApiError) ||
    e.status >= 500 ||
    e.status === 401 ||
    e.status === 403 ||
    e.code === 'IDEMPOTENCY_CONFLICT'
  );
}
const changed = () => window.dispatchEvent(new Event('financial-command-changed'));
async function exclusive<T>(actorId: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new FinancialJournalError(
      'تعذر حماية الإقرار بين صفحات المتصفح. افتح العرض في متصفح يدعم الحفظ الآمن للإقرارات.',
    );
  return navigator.locks.request(
    `logistics:financial-command:${actorId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new FinancialJournalError(
          'تجري متابعة إقرار لهذا الحساب في صفحة أخرى. انتظر اكتمالها ثم حدّث السجل.',
        );
      try {
        return await run();
      } finally {
        changed();
      }
    },
  );
}
export async function sendFinancialCommand(command: FinancialCommand) {
  return exclusive(command.actorId, async () => {
    const saved = saveFinancialCommand(command);
    changed();
    try {
      await api(saved.url, {
        method: 'POST',
        body: saved.body,
        headers: { 'idempotency-key': saved.key, 'x-financial-actor': saved.actorId },
      });
      clearFinancialCommand(saved);
    } catch (e) {
      if (!retainedFinancialError(e)) clearFinancialCommand(saved);
      throw e;
    }
  });
}
export async function inspectFinancialCommand(command: FinancialCommand): Promise<FinancialResult> {
  return exclusive(command.actorId, async () => {
    const current = readFinancialCommand(command.actorId);
    if (!current || !same(current, command))
      throw new FinancialJournalError('تغير سجل الإقرار. حدّث القراءة قبل متابعة نتيجته.');
    const result = await api<FinancialResult>('/api/financial-commands/status', {
      method: 'POST',
      body: JSON.stringify({ url: current.url, body: current.body, key: current.key }),
      headers: { 'x-financial-actor': current.actorId },
    });
    if (result.state === 'committed') clearFinancialCommand(current);
    return result;
  });
}
