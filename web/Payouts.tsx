import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Banknote, RefreshCw, ShieldCheck, LoaderCircle } from 'lucide-react';
import type { Account } from '../shared/contracts.js';
import type { Payout, PayoutView } from '../shared/payouts.js';
import { cashMoney, parseCash } from './Cash.js';
import { FinancialRecovery, useFinancialRecovery } from './FinancialRecovery.js';
import {
  sendFinancialCommand,
  FinancialJournalError,
  retainedFinancialError,
} from './financial-journal.js';
import type { FinancialCommand } from '../shared/financial-recovery.js';
import { api, ApiError, key } from './api.js';
const labels = {
  reserved: 'مستحقات محجوزة',
  released: 'خرج النقد — بانتظار المتجر',
  received: 'أكد المتجر الاستلام',
  cancelled: 'أُلغي الحجز',
  returned: 'استلمت العمليات النقد المرتجع',
  recovered: 'استُردت الدفعة — المستحق مفتوح مجددًا',
};
const actions = {
  request_recovery: 'إقرار رد الدفعة المستلمة',
  receive_recovery: 'استلام الدفعة المرتجعة',
  request_return: 'إقرار إرجاع النقد',
  receive_return: 'استلام النقد المرتجع',
  create: 'حجز صرف مستحقات',
  release: 'تسليم نقد المستحقات',
  confirm: 'تأكيد استلام المستحقات',
  cancel: 'إلغاء حجز الصرف',
  report_issue: 'توثيق فرق في الاستلام',
};
type Target =
  | { action: 'create'; eligible: PayoutView['eligible'][number] }
  | {
      action:
        | 'release'
        | 'confirm'
        | 'cancel'
        | 'report_issue'
        | 'request_return'
        | 'receive_return'
        | 'request_recovery'
        | 'receive_recovery';
      row: Payout;
    };
export function Payouts({ account }: { account: Account }) {
  const [view, setView] = useState<PayoutView | null>(null),
    [error, setError] = useState(''),
    [target, setTarget] = useState<Target | null>(null),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const recovery = useFinancialRecovery(account.id);
  const pending = useRef<FinancialCommand | null>(null),
    submitting = useRef(false),
    form = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    setView(await api<PayoutView>('/api/payouts'));
    setError('');
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  const locked = busy || uncertain || recovery.blocked,
    actual = parseCash(amount),
    hasAmount =
      target &&
      [
        'release',
        'confirm',
        'report_issue',
        'request_return',
        'receive_return',
        'request_recovery',
        'receive_recovery',
      ].includes(target.action),
    expected = target
      ? target.action === 'create'
        ? target.eligible.amountMinor
        : target.row.amountMinor
      : 0;
  function open(t: Target) {
    setTarget(t);
    setAmount('');
    setReference('');
    setReason('');
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current) return;
    if (!reviewed || (hasAmount && (!Number.isSafeInteger(actual) || actual < 0))) {
      setError('راجع الإقرار والمبلغ قبل التأكيد.');
      return;
    }
    const url =
      target.action === 'create' ? '/api/payouts' : `/api/payouts/${target.row.id}/actions`;
    const body = JSON.stringify(
      target.action === 'create'
        ? {
            shipmentId: target.eligible.shipmentId,
            expectedCollectionVersion: target.eligible.collectionVersion,
            reference,
            reason,
          }
        : {
            action: target.action,
            expectedVersion: target.row.version,
            reference,
            reason,
            ...(hasAmount ? { amountMinor: actual, currency: 'SYP' } : {}),
          },
    );
    if (pending.current?.body !== body || pending.current.url !== url)
      pending.current = {
        version: 1,
        actorId: account.id,
        url,
        body,
        key: key(),
        label: actions[target.action],
        createdAt: Date.now(),
      };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await sendFinancialCommand(pending.current);
      pending.current = null;
      setUncertain(false);
      setTarget(null);
      try {
        await load();
      } catch {
        setView(null);
        setError('حُفظ إجراء الصرف؛ تعذر تحديث القراءة. حدّث المستحقات قبل إجراء جديد.');
      }
    } catch (e) {
      if (e instanceof FinancialJournalError) {
        pending.current = null;
        setUncertain(false);
        setTarget(null);
        recovery.refresh();
        setError(e.message);
      } else if (retainedFinancialError(e)) {
        setUncertain(true);
        setError(
          e instanceof ApiError && e.status < 500
            ? e.message
            : 'لم نتأكد من نتيجة الحفظ. أعد نفس إقرار الصرف دون تعديل الحقول؛ لن تتكرر الحركة المالية.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        if (
          ['VERSION_CONFLICT', 'CASH_INCONSISTENT', 'PAYOUT_EXISTS', 'PAYOUT_NOT_FUNDED'].includes(
            (e as ApiError).code,
          )
        ) {
          setTarget(null);
          try {
            await load();
          } catch {
            setView(null);
          }
        }
        setError((e as Error).message);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="inventory-view">
      <section className="inventory-intro">
        <div>
          <span className="eyebrow">استلام المتجر هو الذي يغلق مستحقاته</span>
          <h2>صرف مستحقات المتاجر</h2>
          <p>
            نصرف قيمة البضائع فقط من نقد استلمته العمليات. حجز المستحق لا يعني خروج المال، وخروج
            النقد لا يعني استلام المتجر. جميع المبالغ محاكاة تجريبية.
          </p>
        </div>
        <Banknote size={42} />
      </section>
      <div className="transfer-toolbar">
        <span className="audit-status">
          {view ? `${view.total} طلبات صرف في نطاقك` : 'جارٍ تحميل المستحقات…'}
        </span>
        <button
          className="button secondary"
          disabled={locked || !!target}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} />
          تحديث المستحقات
        </button>
      </div>
      {!target && (
        <FinancialRecovery
          key={recovery.command?.key ?? 'empty'}
          command={recovery.command}
          error={recovery.error}
          onRefresh={recovery.refresh}
          onRejected={async (message) => {
            pending.current = null;
            setUncertain(false);
            setTarget(null);
            setView(null);
            try {
              await load();
            } catch {}
            setError(message);
          }}
          onDone={async () => {
            pending.current = null;
            setUncertain(false);
            setTarget(null);
            setView(null);
            try {
              await load();
            } catch {
              setError('انتهى الإقرار المحفوظ؛ تعذر تحديث المستحقات. حدّث القراءة قبل إقرار جديد.');
            }
          }}
        />
      )}

      {view && (
        <div className="cash-metrics">
          {[
            ['متاحة لحجز الصرف', view.availableMinor],
            ['محجوزة قبل الخروج', view.reservedMinor],
            ['خرجت بانتظار المتجر', view.inTransitMinor],
            ['صافي الدفعات المستلمة', view.paidMinor],
            ['رد دفعات بانتظار العمليات', view.recoveryPendingMinor],
          ].map(([label, value]) => (
            <div className="panel" key={String(label)}>
              <span>{label}</span>
              <strong>{cashMoney(Number(value))}</strong>
            </div>
          ))}
        </div>
      )}
      {view && view.recoveryPendingMinor > 0 && (
        <p className="scope-note">
          رد الدفعات المعلق جزء من صافي الدفعات المستلمة، وليس مبلغًا إضافيًا أو نقدًا متاحًا. ينخفض
          الصافي وتُفتح المستحقات بعد وصول النقد إلى العمليات فقط.
        </p>
      )}
      {view && !view.consistent && (
        <p className="alert" role="alert">
          حالات الصرف لا تطابق القيود. يلزم التحقيق قبل أي حركة مالية.
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {target && (
        <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
          <h3>
            {actions[target.action]} ·{' '}
            {target.action === 'create'
              ? target.eligible.shipmentReference
              : target.row.shipmentReference}
          </h3>
          <p>
            المتجر:{' '}
            {target.action === 'create' ? target.eligible.merchantName : target.row.merchantName} ·
            قيمة البضائع {cashMoney(expected)}.{' '}
            {target.action === 'create'
              ? 'سيحجز كامل المستحق، دون خروج نقد أو إغلاق الدين.'
              : target.action === 'release'
                ? 'أكد تسليم النقد فعليًا. سيخرج من العمليات وتبقى المستحقات مفتوحة حتى يؤكد المتجر.'
                : target.action === 'confirm'
                  ? 'أدخل كامل المبلغ الذي استلمته فعلًا؛ التأكيد يغلق مستحق هذا الطلب.'
                  : target.action === 'request_recovery'
                    ? 'أكد رد كامل الدفعة التي استلمتها فعلًا. تبقى الدفعة مستلمة والمستحق مغلقًا حتى تؤكد العمليات وصول النقد.'
                    : target.action === 'receive_recovery'
                      ? 'أكد وصول كامل الدفعة فعليًا. ستعود إلى الخزينة ويُفتح مستحق المتجر مجددًا مع حفظ إقراراته الأصلية؛ هذا ليس ردًا للعميل.'
                      : target.action === 'request_return'
                        ? 'أكد إرجاع كامل النقد فعليًا. تبقى العهدة والمستحقات مفتوحة حتى تستلمه العمليات؛ لا يمكن تأكيد الاستلام بعدها.'
                        : target.action === 'receive_return'
                          ? 'أكد استلام كامل النقد المرتجع فعليًا. يعكس قيد الخروج، وتصبح المستحقات متاحة للصرف مجددًا.'
                          : target.action === 'cancel'
                            ? 'يلغى الحجز قبل خروج النقد فقط، وتصبح القيمة متاحة للحجز مجددًا.'
                            : 'توثيق الفرق لا يغلق العهدة ولا يشطب مستحقاتك.'}
          </p>
          <fieldset className="inventory-fields" disabled={locked}>
            {hasAmount && (
              <label>
                المبلغ الفعلي بالليرة السورية
                <input
                  aria-label="المبلغ الفعلي بالليرة السورية"
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
            )}
            <label>
              مرجع إقرار الصرف
              <input
                aria-label="مرجع إقرار الصرف"
                required
                minLength={3}
                maxLength={100}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label>
              سبب إجراء الصرف
              <input
                aria-label="سبب إجراء الصرف"
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label className="transfer-review">
              <input
                type="checkbox"
                required
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              راجعت أثر الإقرار على النقد والمستحقات وأؤكد التسجيل باسم حسابي.
            </label>
          </fieldset>
          {hasAmount && Number.isSafeInteger(actual) && (
            <p className={`count-preview ${actual !== expected ? 'invalid' : ''}`}>
              الفرق عن المستحق: {cashMoney(actual - expected)}
            </p>
          )}
          <div className="button-row">
            <button
              type="submit"
              className="button primary"
              disabled={
                busy ||
                !reviewed ||
                !!(
                  hasAmount &&
                  (!Number.isSafeInteger(actual) ||
                    actual < 0 ||
                    (target.action === 'report_issue' ? actual === expected : actual !== expected))
                )
              }
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}تأكيد
              إقرار الصرف
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={locked}
              onClick={() => setTarget(null)}
            >
              إغلاق النموذج
            </button>
          </div>
        </form>
      )}
      {view && view.eligible.length > 0 && (
        <section className="panel inventory-panel">
          <h3>مستحقات وصلت أموالها إلى العمليات</h3>
          <p className="scope-note">
            لا تُحجز رسوم التوصيل ولا أموال ما زالت بعهدة المندوب أو النقطة. نعرض أول 50 مستحقًا؛
            الإجمالي يشمل نطاقك كله.
          </p>
          <div className="transfer-grid">
            {view.eligible.map((e) => (
              <article className="panel transfer-card" key={e.shipmentId}>
                <h3>{e.shipmentReference}</h3>
                <p>{e.merchantName}</p>
                <strong>{cashMoney(e.amountMinor)}</strong>
                {account.role === 'operator' && (
                  <button
                    className="button primary"
                    disabled={locked || !view.consistent}
                    onClick={() => open({ action: 'create', eligible: e })}
                  >
                    حجز صرف المستحق
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="transfer-grid">
        {view?.rows.map((p) => (
          <article className="panel transfer-card" key={p.id}>
            <div className="site-card-title">
              <h3>PAY-{p.id.slice(0, 8)}</h3>
              <span className={'audit-status ' + (p.issueOpen ? 'exception' : '')}>
                {p.status === 'released' && p.returnRequested
                  ? 'قيد الإرجاع — بانتظار العمليات'
                  : p.status === 'received' && p.recoveryRequested
                    ? 'رد دفعة مستلمة — بانتظار العمليات'
                    : labels[p.status]}
              </span>
            </div>
            <p>
              {p.merchantName} · {p.shipmentReference}
            </p>
            <strong>{cashMoney(p.amountMinor)}</strong>
            {p.issueOpen && (
              <p className="transfer-warning">
                فرق موثق مفتوح. المال خارج العمليات، والمستحقات لم تُغلق.
              </p>
            )}
            {p.returnRequested && p.status === 'released' && (
              <p className="scope-note">
                وثق المتجر إرجاع النقد. لا تتغير الأرصدة قبل وصول كامل المبلغ إلى العمليات.
              </p>
            )}
            {p.status === 'received' && p.recoveryRequested && (
              <p className="scope-note">
                أقر المتجر رد الدفعة. تبقى المستحقات مغلقة حتى تستلم العمليات كامل النقد؛ لا تُتاح
                دفعة جديدة قبل وصوله.
              </p>
            )}
            {p.status === 'recovered' && (
              <p className="scope-note">
                وصل النقد إلى العمليات وأُعيد فتح المستحق. حُفظ إقرار المتجر الأصلي بالاستلام، ويمكن
                حجز دفعة جديدة.
              </p>
            )}
            <div className="button-row">
              {p.status === 'received' &&
                ((account.role === 'merchant' && !p.recoveryRequested) ||
                  (account.role === 'operator' && p.recoveryRequested)) && (
                  <button
                    className="button secondary"
                    disabled={locked || !view.consistent}
                    onClick={() =>
                      open({
                        action:
                          account.role === 'merchant' ? 'request_recovery' : 'receive_recovery',
                        row: p,
                      })
                    }
                  >
                    {account.role === 'merchant'
                      ? 'إقرار رد الدفعة المستلمة'
                      : 'استلام الدفعة المرتجعة'}
                  </button>
                )}
              {p.status === 'released' &&
                ((account.role === 'merchant' && !p.returnRequested) ||
                  (account.role === 'operator' && p.returnRequested)) && (
                  <button
                    className="button secondary"
                    disabled={locked || !view.consistent}
                    onClick={() =>
                      open({
                        action: account.role === 'merchant' ? 'request_return' : 'receive_return',
                        row: p,
                      })
                    }
                  >
                    {account.role === 'merchant' ? 'إقرار إرجاع النقد' : 'استلام النقد المرتجع'}
                  </button>
                )}
              {account.role === 'operator' && p.status === 'reserved' && (
                <>
                  <button
                    className="button primary"
                    disabled={locked || !view.consistent}
                    onClick={() => open({ action: 'release', row: p })}
                  >
                    تسليم نقد المستحقات
                  </button>
                  <button
                    className="button secondary"
                    disabled={locked}
                    onClick={() => open({ action: 'cancel', row: p })}
                  >
                    إلغاء حجز الصرف
                  </button>
                </>
              )}
              {account.role === 'merchant' && p.status === 'released' && !p.returnRequested && (
                <button
                  className="button primary"
                  disabled={locked || !view.consistent}
                  onClick={() => open({ action: 'confirm', row: p })}
                >
                  تأكيد استلام المستحقات
                </button>
              )}
              {p.status === 'released' && !p.returnRequested && (
                <button
                  className="button secondary"
                  disabled={locked}
                  onClick={() => open({ action: 'report_issue', row: p })}
                >
                  توثيق فرق في الاستلام
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {view && view.total === 0 && !view.eligible.length && (
        <section className="panel transfer-empty">
          <Banknote size={35} />
          <h3>لا توجد مستحقات قابلة للصرف في نطاقك</h3>
          <p>تظهر قيمة البضائع هنا بعد تحصيل الطلب واستلام العمليات لكامل نقده.</p>
        </section>
      )}
      {view && view.total > view.rows.length && (
        <p className="scope-note">
          أول 50 طلب صرف بأولوية الحجز والعهدة المفتوحة ورد الدفعات المعلق؛ الإجمالي يشمل نطاقك كله.
        </p>
      )}
      {view && (
        <section className="panel inventory-panel">
          <h3>سجل إقرارات الصرف</h3>
          <div className="inventory-ledger">
            {view.history.map((e) => (
              <div key={e.id}>
                <div>
                  <strong>
                    {e.action === 'reserved'
                      ? 'حجز صرف'
                      : (actions[e.action as keyof typeof actions] ?? e.action)}{' '}
                    · {e.actorName}
                  </strong>
                  <p>
                    {e.reference} · {e.reason}
                  </p>
                  {typeof e.details.amountMinor === 'number' && (
                    <p>المبلغ {cashMoney(e.details.amountMinor)}</p>
                  )}
                  <small>{new Date(e.createdAt).toLocaleString('ar-SY')}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
