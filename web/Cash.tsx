import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Wallet, RefreshCw, ShieldCheck, LoaderCircle } from 'lucide-react';
import type { Account } from '../shared/contracts.js';
import type { CashRow, CashView } from '../shared/cash.js';
import { parseCashAmount } from '../shared/cash.js';
import { FinancialRecovery, useFinancialRecovery } from './FinancialRecovery.js';
import {
  sendFinancialCommand,
  FinancialJournalError,
  retainedFinancialError,
} from './financial-journal.js';
import type { FinancialCommand } from '../shared/financial-recovery.js';
import { api, ApiError, key } from './api.js';
export const cashMoney = (n: number) => new Intl.NumberFormat('ar-SY').format(n / 100) + ' ل.س';
export function parseCash(value: string) {
  return parseCashAmount(value);
}
const actionLabels = {
  receive: 'استلام عهدة نقدية',
  report_difference: 'توثيق فرق نقدي',
  return_difference: 'توثيق فرق في رجوع الحوالة',
  return_request: 'طلب رجوع الحوالة',
  return_release: 'تسليم نقد الحوالة المرتجع',
  return_confirm: 'تأكيد استلام الحوالة المرتجعة',
  return_cancel: 'إلغاء طلب رجوع الحوالة',
};
type CashAction = keyof typeof actionLabels;
export function Cash({ account }: { account: Account }) {
  const [view, setView] = useState<CashView | null>(null),
    [error, setError] = useState(''),
    [target, setTarget] = useState<{
      row: CashRow;
      action: CashAction;
    } | null>(null),
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
    setView(await api<CashView>('/api/cash'));
    setError('');
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  const locked = busy || uncertain || recovery.blocked,
    actual = parseCash(amount);
  function open(row: CashRow, action: CashAction) {
    setTarget({ row, action });
    setAmount('');
    setReference('');
    setReason('');
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current) return;
    if (!Number.isSafeInteger(actual) || actual < 0 || !reviewed) {
      setError('أدخل مبلغًا صحيحًا وراجع الإقرار قبل التأكيد.');
      return;
    }
    const body = JSON.stringify({
      action: target.action,
      expectedVersion: target.row.version,
      amountMinor: actual,
      currency: target.row.currency,
      reference,
      reason,
    });
    const url = `/api/cash/${target.row.shipmentId}/actions`;
    if (pending.current?.body !== body || pending.current.url !== url)
      pending.current = {
        version: 1,
        actorId: account.id,
        url,
        body,
        key: key(),
        label: actionLabels[target.action],
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
        setError('حُفظ الإقرار؛ تعذر تحديث القراءة. حدّث العهدة قبل أي إجراء جديد.');
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
            : 'لم نتأكد من نتيجة الحفظ. أعد نفس الإقرار دون تغيير الحقول؛ لن تتكرر الحركة المالية.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        if (
          [
            'VERSION_CONFLICT',
            'CASH_INCONSISTENT',
            'RETURN_PENDING',
            'PAYOUT_BLOCKS_RETURN',
          ].includes((e as ApiError).code)
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
  const metrics = view
    ? ([
        ['بانتظار التحصيل', view.pendingMinor],
        ['في عهدة المحصلين', view.heldMinor],
        ['إجمالي استلام العمليات تاريخيًا', view.receivedMinor],
        ['صافي الحوالات بعد الرجوع', view.netRemittedMinor],
        ['نقد رجوع بانتظار المحصل', view.remittanceReturnTransitMinor],
        ['نقد متبقٍ لدى العمليات', view.operationsBalanceMinor],
        ['خرج للصرف بانتظار المتجر', view.payoutInTransitMinor],
        ['قيمة بضائع مستحقة للمتاجر', view.goodsLiabilityMinor],
        ['رسوم توصيل بانتظار التوزيع', view.deliveryClearingMinor],
      ] as const)
    : [];
  return (
    <div className="inventory-view">
      <section className="inventory-intro">
        <div>
          <span className="eyebrow">تسليم الطرد لا يغلق عهدة الأموال</span>
          <h2>التحصيل وعهدة النقد</h2>
          <p>
            مبالغ تجريبية بالليرة السورية. إقرار المحصل يسجل النقد في عهدته، واستلام العمليات مستقل؛
            لا يعني صرف مستحقات المتجر.
          </p>
        </div>
        <Wallet size={42} />
      </section>
      <div className="transfer-toolbar">
        <span className="audit-status">
          {view ? `${view.total} طلبات نقدية في نطاقك` : 'جارٍ قراءة العهدة…'}
        </span>
        <button
          className="button secondary"
          disabled={locked || !!target}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} />
          تحديث العهدة المالية
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
              setError('انتهى الإقرار المحفوظ؛ تعذر تحديث العهدة. حدّث القراءة قبل إقرار جديد.');
            }
          }}
        />
      )}

      <div className="cash-metrics">
        {metrics.map(([label, value]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{cashMoney(value)}</strong>
          </div>
        ))}
      </div>
      {view &&
        (view.remittanceReturnTransitMinor > 0 || view.receivedMinor !== view.netRemittedMinor) && (
          <p className="scope-note">
            إجمالي الاستلام تاريخي ويشمل الحوالات المصححة. نقد الرجوع المعلق جزء من صافي الحوالات،
            وليس رصيدًا إضافيًا أو نقدًا متبقيًا في الخزينة. لا تجمع هذه المقاييس كأموال مستقلة.
          </p>
        )}
      {view && view.returnIssueCount > 0 && (
        <p className="transfer-warning" role="status">
          {view.returnIssueCount} حالات رجوع نقد بفرق مفتوح في نطاقك. تسجيل الفرق لا يغيّر الأرصدة
          ولا يشطب العهدة.
        </p>
      )}
      {view && !view.consistent && (
        <p className="alert" role="alert">
          القيود لا تطابق حالات التحصيل؛ يلزم التحقيق. لا تُصحّح الأرقام تلقائيًا.
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
            {actionLabels[target.action]} · {target.row.shipmentReference}
          </h3>
          <p>
            المحصل: {target.row.collectorName} · كامل العهدة {cashMoney(target.row.totalMinor)}.{' '}
            {target.action === 'receive'
              ? 'أكد النقد الذي استلمته فعليًا؛ الاستلام لا يصرف مستحقات المتجر.'
              : target.action === 'report_difference'
                ? 'توثيق الفرق يبقي كامل العهدة مفتوحة ولا ينشئ استلامًا جزئيًا أو شطبًا.'
                : target.action === 'return_difference'
                  ? 'أدخل كامل المبلغ المعدود فعليًا عند مراجعة الرجوع. توثيق النقص أو الزيادة يبقي كامل عهدة الرجوع مفتوحة ولا يسجل استلامًا جزئيًا أو شطبًا.'
                  : target.action === 'return_request'
                    ? 'سيتوقف صرف المتجر من هذه الحوالة. الطلب لا يخرج نقدًا ولا يعيد عهدة المحصل.'
                    : target.action === 'return_release'
                      ? 'أكد تسليم كامل النقد فعليًا إلى المحصل الأصلي. يخرج من الخزينة ويظل في عهدة الرجوع حتى يقر المحصل بوصوله.'
                      : target.action === 'return_confirm'
                        ? 'أكد استلام كامل النقد فعليًا. تعود العهدة المالية إلى حسابك دون تحصيل العميل مرة أخرى؛ يمكن للعمليات استلامها لاحقًا بحوالة جديدة.'
                        : 'يمكن إلغاء طلب الرجوع قبل خروج النقد فقط، مع حفظ تاريخه.'}
          </p>
          <fieldset className="inventory-fields" disabled={locked}>
            <label>
              المبلغ المعدود فعليًا بالليرة السورية
              <input
                aria-label="المبلغ المعدود فعليًا بالليرة السورية"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label>
              مرجع الإيصال أو محضر الفرق
              <input
                aria-label="مرجع الإيصال أو محضر الفرق"
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
              سبب الإقرار المالي
              <input
                aria-label="سبب الإقرار المالي"
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
              راجعت المبلغ والمرجع وأؤكد الإقرار باسم حسابي.
            </label>
          </fieldset>
          {Number.isSafeInteger(actual) && (
            <p className={`count-preview ${actual !== target.row.totalMinor ? 'invalid' : ''}`}>
              الفرق عن العهدة: {cashMoney(actual - target.row.totalMinor)}
            </p>
          )}
          <div className="button-row">
            <button
              className="button primary"
              disabled={
                busy ||
                !Number.isSafeInteger(actual) ||
                actual < 0 ||
                !reviewed ||
                (['report_difference', 'return_difference'].includes(target.action)
                  ? actual === target.row.totalMinor
                  : actual !== target.row.totalMinor)
              }
              type="submit"
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}تأكيد
              الإقرار المالي
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
      <div className="transfer-grid">
        {view?.rows.map((row) => (
          <article className="panel transfer-card" key={row.shipmentId}>
            <div className="site-card-title">
              <h3>{row.shipmentReference}</h3>
              <span
                className={
                  'audit-status ' +
                  (row.issueOpen || row.remittanceReturn?.issueOpen ? 'exception' : '')
                }
              >
                {row.status === 'pending' &&
                ['cancelled', 'returned', 'returning'].includes(row.shipmentStatus)
                  ? 'لا تحصيل — إلغاء أو إرجاع'
                  : row.status === 'pending'
                    ? 'لم يُحصّل'
                    : row.status === 'collected'
                      ? 'في عهدة المحصل'
                      : row.remittanceReturn?.status === 'released'
                        ? 'نقد رجوع — بانتظار المحصل'
                        : row.remittanceReturn?.status === 'requested'
                          ? 'رجوع حوالة مطلوب — لم يخرج النقد'
                          : 'استلمتها العمليات'}
              </span>
            </div>
            <p>
              {row.merchantName} · {row.collectorName ?? 'لم يسجل محصل بعد'}
            </p>
            <div className="transfer-lines">
              <div>
                <strong>قيمة البضائع</strong>
                <span>{cashMoney(row.goodsMinor)}</span>
              </div>
              <div>
                <strong>رسوم التوصيل</strong>
                <span>{cashMoney(row.feeMinor)}</span>
              </div>
              <div>
                <strong>كامل المبلغ</strong>
                <span>{cashMoney(row.totalMinor)}</span>
              </div>
            </div>
            {row.issueOpen && (
              <p className="transfer-warning">فرق نقدي مفتوح؛ لم تُغلق العهدة ولم يُشطب المبلغ.</p>
            )}
            {row.status === 'pending' && (
              <p>قد يُلغى الطلب أو يُعاد دون تحصيل. لا توجد مستحقات مسجلة بمجرد إنشاء الطلب.</p>
            )}
            {row.remittanceReturn && (
              <p className="scope-note">
                تصحيح الحوالة يخص رجوع النقد إلى محصله الأصلي فقط. لا يغير تحصيل العميل أو تسليم
                الطرد، ولا يصرف مستحق المتجر.
              </p>
            )}
            {row.remittanceReturn?.issueOpen && (
              <p className="transfer-warning">
                فرق رجوع مفتوح؛ المبلغ المعدود{' '}
                {cashMoney(row.remittanceReturn.lastReportedMinor ?? 0)}، والفرق{' '}
                {cashMoney((row.remittanceReturn.lastReportedMinor ?? 0) - row.totalMinor)}. تبقى
                كامل عهدة الرجوع مفتوحة حتى يقر المحصل بوصول المبلغ كاملًا.
              </p>
            )}
            {row.remittanceCount > 1 && (
              <p className="scope-note">
                استلام العمليات الحالي هو الحوالة رقم {row.remittanceCount}؛ الحوالات المصححة محفوظة
                في السجل.
              </p>
            )}
            {row.remittanceReturn?.status === 'released' &&
              ['operator', 'courier', 'pickup'].includes(account.role) && (
                <button
                  className="button secondary"
                  disabled={locked || !view.consistent}
                  onClick={() => open(row, 'return_difference')}
                >
                  توثيق فرق في رجوع الحوالة
                </button>
              )}
            {row.status === 'received' && (
              <div className="button-row">
                {account.role === 'operator' && !row.remittanceReturn && (
                  <button
                    className="button secondary"
                    disabled={locked || !view.consistent}
                    onClick={() => open(row, 'return_request')}
                  >
                    طلب رجوع الحوالة
                  </button>
                )}
                {account.role === 'operator' && row.remittanceReturn?.status === 'requested' && (
                  <>
                    <button
                      className="button primary"
                      disabled={locked || !view.consistent}
                      onClick={() => open(row, 'return_release')}
                    >
                      تسليم نقد الحوالة المرتجع
                    </button>
                    <button
                      className="button secondary"
                      disabled={locked}
                      onClick={() => open(row, 'return_cancel')}
                    >
                      إلغاء طلب رجوع الحوالة
                    </button>
                  </>
                )}
                {['courier', 'pickup'].includes(account.role) &&
                  row.remittanceReturn?.status === 'released' && (
                    <button
                      className="button primary"
                      disabled={locked || !view.consistent}
                      onClick={() => open(row, 'return_confirm')}
                    >
                      تأكيد استلام الحوالة المرتجعة
                    </button>
                  )}
              </div>
            )}
            {account.role === 'operator' && row.status === 'collected' && (
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={locked}
                  onClick={() => open(row, 'receive')}
                >
                  استلام عهدة الأموال
                </button>
                <button
                  className="button secondary"
                  disabled={locked}
                  onClick={() => open(row, 'report_difference')}
                >
                  تسجيل فرق نقدي
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {view?.total === 0 && (
        <section className="panel transfer-empty">
          <Wallet size={35} />
          <h3>لا توجد تحصيلات نقدية في نطاقك</h3>
          <p>
            اختر النقد عند الاستلام في المتجر لإنشاء رحلة مالية تجريبية؛ الطلبات السابقة لا تُحوّل
            إلى نقد بأثر رجعي.
          </p>
        </section>
      )}
      {view && view.total > view.rows.length && (
        <p className="scope-note">
          أول 50 طلبًا بأولوية العهدة المفتوحة؛ الإجماليات تشمل نطاق الحساب كله.
        </p>
      )}
      {view && (
        <section className="panel inventory-panel">
          <h3>سجل الإقرارات المالية</h3>
          <div className="inventory-ledger">
            {view.history.map((e) => (
              <div key={e.id}>
                <div>
                  <strong>
                    {e.action === 'collected'
                      ? 'إقرار تحصيل'
                      : e.action === 'receive'
                        ? 'إقرار استلام العمليات'
                        : (actionLabels[e.action as CashAction] ?? 'توثيق فرق')}{' '}
                    · {e.shipmentReference}
                  </strong>
                  <p>
                    {e.actorName} · {e.reference} · {e.reason}
                  </p>
                  {typeof e.details.actualMinor === 'number' && (
                    <p>
                      المعدود {cashMoney(e.details.actualMinor)} · الفرق{' '}
                      {cashMoney(Number(e.details.differenceMinor))}
                    </p>
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
