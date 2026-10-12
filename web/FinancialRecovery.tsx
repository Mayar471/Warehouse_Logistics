import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.js';
import { ShieldCheck, RefreshCw, LoaderCircle } from 'lucide-react';
import type { FinancialCommand } from '../shared/financial-recovery.js';
import {
  readFinancialCommand,
  sendFinancialCommand,
  inspectFinancialCommand,
  retainedFinancialError,
} from './financial-journal.js';
function snapshot(actorId: string) {
  try {
    return { command: readFinancialCommand(actorId), error: '' };
  } catch (e) {
    return { command: null, error: (e as Error).message };
  }
}
export function useFinancialRecovery(actorId: string) {
  const [state, setState] = useState(() => snapshot(actorId));
  const refresh = useCallback(() => setState(snapshot(actorId)), [actorId]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea === localStorage) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('financial-command-changed', refresh);
    refresh();
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('financial-command-changed', refresh);
    };
  }, [refresh]);
  return { ...state, refresh, blocked: !!state.command || !!state.error };
}
export function FinancialNotice({
  actorId,
  onOpen,
}: {
  actorId: string;
  onOpen: (nav: 'cash' | 'payouts' | 'returns') => void;
}) {
  const recovery = useFinancialRecovery(actorId);
  if (!recovery.blocked) return null;
  return (
    <section className="panel transfer-toolbar financial-recovery-notice" role="status">
      <span>يوجد إقرار مالي يحتاج متابعة لهذا الحساب.</span>
      <button
        className="button secondary"
        onClick={() =>
          onOpen(
            recovery.command?.url.startsWith('/api/payouts')
              ? 'payouts'
              : recovery.command?.url.startsWith('/api/refunds')
                ? 'returns'
                : 'cash',
          )
        }
      >
        متابعة الإقرار المالي
      </button>
    </section>
  );
}
export function FinancialRecovery({
  command,
  error,
  onDone,
  onRefresh,
  onRejected,
}: {
  command: FinancialCommand | null;
  error: string;
  onDone: () => Promise<void>;
  onRefresh: () => void;
  onRejected: (message: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(false);
  useEffect(() => {
    setReviewed(false);
    setConflict(false);
    setMessage('');
  }, [command?.key, command?.body, command?.url]);
  const payload = command ? (JSON.parse(command.body) as Record<string, unknown>) : null;
  async function check() {
    if (!command) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await inspectFinancialCommand(command);
      if (result.state === 'committed') await onDone();
      else if (result.state === 'unknown')
        setMessage(
          'لم يجد الخادم إقرارًا محفوظًا بهذا المرجع. هذا لا يثبت وحده أن الطلب السابق انتهى؛ يمكنك إعادة الإقرار نفسه بعد مراجعته.',
        );
      else {
        setConflict(true);
        setMessage(
          'مرجع الإقرار مسجل بمحتوى مختلف. يلزم مراجعة السجل المالي؛ لن نرسل محتوى جديدًا بهذا المرجع.',
        );
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }
  async function retry() {
    if (!command || !reviewed || conflict) return;
    setBusy(true);
    setMessage('');
    try {
      await sendFinancialCommand(command);
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && !retainedFinancialError(e)) await onRejected(e.message);
      else setMessage((e as Error).message);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }
  if (!command && !error) return null;
  return (
    <section
      className="panel inventory-form financial-recovery"
      aria-label="استعادة الإقرار المالي"
    >
      <h3>
        <ShieldCheck size={18} /> إقرار مالي يحتاج متابعة
      </h3>
      <p>
        حُفظ هذا الإقرار للحساب قبل إرساله. افحص نتيجة الحفظ، أو أعد الإقرار نفسه بعد مراجعته. يمنع
        مفتاحه تكرار الحركة، وتبقى الإقرارات الجديدة متوقفة حتى تتضح النتيجة.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {command && payload && (
        <>
          <strong>{command.label}</strong>
          <p>
            المرجع: {String(payload.reference)} · السبب: {String(payload.reason)}
          </p>
          {typeof payload.amountMinor === 'number' && (
            <p>
              المبلغ في الإقرار: {new Intl.NumberFormat('ar-SY').format(payload.amountMinor / 100)}{' '}
              ل.س
            </p>
          )}
          <small>حُفظ للمراجعة: {new Date(command.createdAt).toLocaleString('ar-SY')}</small>
          <label className="transfer-review">
            <input
              type="checkbox"
              disabled={busy || conflict}
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            راجعت الإقرار المحفوظ وأوافق على إعادة إرساله دون تغيير.
          </label>
          <div className="button-row">
            <button className="button secondary" disabled={busy} onClick={() => void check()}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}فحص
              نتيجة الحفظ
            </button>
            <button
              className="button primary"
              disabled={busy || !reviewed || conflict}
              onClick={() => void retry()}
            >
              إعادة إرسال الإقرار المحفوظ
            </button>
          </div>
        </>
      )}
      {!command && (
        <button className="button secondary" onClick={onRefresh}>
          إعادة قراءة سجل الاستعادة
        </button>
      )}
      {message && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
