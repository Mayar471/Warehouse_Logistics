import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Account } from '../shared/contracts.js';
import {
  partnerActions,
  type PartnerAction,
  type PartnerPayment,
  type PartnerPaymentView,
} from '../shared/partner-payments.js';
import type { FinancialCommand } from '../shared/financial-recovery.js';
import { api, key } from './api.js';
import { cashMoney, parseCash } from './Cash.js';
import { FinancialRecovery, useFinancialRecovery } from './FinancialRecovery.js';
import { sendFinancialCommand } from './financial-journal.js';
import { ReferenceInput } from './QuickInput.js';
const labels = {
  reserved: 'محجوز',
  released: 'خرج النقد — بانتظار إقرار المستفيد',
  received: 'استلمه المستفيد',
  cancelled: 'أُلغي الحجز',
  returned: 'عاد النقد للصندوق',
  recovered: 'استُرد الأجر',
};
type Target =
  | { action: 'funding' }
  | { action: 'reserve'; shipmentId: string; amountMinor: number }
  | { action: PartnerAction; row: PartnerPayment };
export function PartnerPayments({ account }: { account: Account }) {
  const [view, setView] = useState<PartnerPaymentView | null>(null),
    [error, setError] = useState(''),
    [target, setTarget] = useState<Target | null>(null),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false);
  const submitting = useRef(false),
    recovery = useFinancialRecovery(account.id),
    form = useRef<HTMLFormElement>(null);
  const ops = account.role === 'operator';
  async function load() {
    setView(await api<PartnerPaymentView>('/api/partner-payments'));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  function open(t: Target) {
    setTarget(t);
    setAmount('');
    setReference(t.action === 'funding' ? '' : `ACK-${key().slice(0, 12)}`);
    setReason(
      t.action === 'funding'
        ? 'تمويل مستقل لصندوق أجور التنفيذ'
        : t.action === 'reserve'
          ? 'حجز الأجر المستحق'
          : partnerActions[t.action],
    );
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current || recovery.blocked || !reviewed) return;
    const actual = parseCash(amount),
      needsAmount = target.action !== 'reserve';
    if (
      needsAmount &&
      (!Number.isSafeInteger(actual) || actual < 0 || (target.action === 'funding' && actual === 0))
    ) {
      setError('أدخل مبلغًا صحيحًا بالليرة السورية');
      return;
    }
    const url =
      target.action === 'funding'
        ? '/api/partner-funding'
        : target.action === 'reserve'
          ? '/api/partner-payments'
          : `/api/partner-payments/${target.row.id}/actions`;
    const body = JSON.stringify({
      reference,
      reason,
      ...(target.action === 'reserve'
        ? { shipmentId: target.shipmentId }
        : target.action === 'funding'
          ? { amountMinor: actual, currency: 'SYP' }
          : {
              action: target.action,
              expectedVersion: target.row.version,
              amountMinor: actual,
              currency: 'SYP',
            }),
    });
    const command: FinancialCommand = {
      version: 1,
      actorId: account.id,
      url,
      body,
      key: key(),
      label:
        target.action === 'funding'
          ? 'تمويل صندوق الأجور'
          : target.action === 'reserve'
            ? 'حجز الأجر'
            : partnerActions[target.action],
      createdAt: Date.now(),
    };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await sendFinancialCommand(command);
      setTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تنفيذ الإقرار');
      recovery.refresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const blocked = busy || recovery.blocked;
  return (
    <section className="panel partner-payments" aria-label="صرف أجور الشركاء">
      <div className="panel-title">
        <div>
          <h2>صرف أجور الشركاء</h2>
          <p>حجز، تسليم، ثم إقرار مستقل من المكتب أو المندوب المستقل.</p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          تحديث الصرف
        </button>
      </div>
      <p className="scope-note">
        صندوق الأجور ممول بشكل مستقل. أموال البضائع وردود العملاء لا تدخل في رصيده. جميع الإجراءات
        هنا إقرارات تجريبية وليست تحويلًا بنكيًا.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <FinancialRecovery
        command={recovery.command}
        error={recovery.error}
        onRefresh={recovery.refresh}
        onDone={async () => {
          setTarget(null);
          recovery.refresh();
          await load();
        }}
        onRejected={async (message) => {
          setError(message);
          setTarget(null);
          recovery.refresh();
          await load();
        }}
      />
      {view?.balance && (
        <>
          <div className="partner-balance-grid">
            {[
              ['متاح للحجز', view.balance.availableMinor],
              ['محجوز', view.balance.reservedMinor],
              ['نقد بعهدة الصرف', view.balance.inTransitMinor],
              ['أجور مستلمة', view.balance.paidMinor],
            ].map(([label, value]) => (
              <div className="partner-balance" key={label}>
                <span>{label}</span>
                <strong>{cashMoney(Number(value))}</strong>
              </div>
            ))}
          </div>
          <button
            className="button secondary"
            disabled={blocked}
            onClick={() => open({ action: 'funding' })}
          >
            إثبات تمويل صندوق الأجور
          </button>
        </>
      )}
      {target && (
        <form ref={form} className="partner-payment-form" onSubmit={submit}>
          <h3>
            {target.action === 'funding'
              ? 'تمويل مستقل موثق'
              : target.action === 'reserve'
                ? 'حجز الأجر كاملًا'
                : partnerActions[target.action]}
          </h3>
          {target.action !== 'funding' && (
            <p>
              المبلغ المحدد:{' '}
              {cashMoney(target.action === 'reserve' ? target.amountMinor : target.row.amountMinor)}
            </p>
          )}
          {target.action !== 'reserve' && (
            <label>
              المبلغ الفعلي بالليرة السورية
              <input
                required
                inputMode="decimal"
                aria-label="المبلغ الفعلي بالليرة السورية"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          )}
          {target.action !== 'reserve' &&
            target.action !== 'funding' &&
            target.action !== 'report_issue' && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setAmount(String(target.row.amountMinor / 100))}
              >
                استلمت / سلّمت كامل المبلغ المحدد
              </button>
            )}
          <label>
            {target.action === 'funding' ? 'رقم سند التمويل الخارجي' : 'مرجع الإقرار'}
            {target.action === 'funding' ? (
              <input
                required
                minLength={3}
                maxLength={100}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            ) : (
              <ReferenceInput label="مرجع إقرار الأجور" value={reference} onChange={setReference} />
            )}
          </label>
          {target.action === 'funding' && (
            <p className="scope-note">
              أدخل رقم السند الفعلي من مصدر تمويل الشركة. لا تسجل تحصيل طلب عميل كتمويل.
            </p>
          )}
          {target.action === 'report_issue' && (
            <label>
              تفاصيل الفرق
              <textarea
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <label className="partner-confirm">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            راجعت الإقرار وأؤكد وقوع هذا الإجراء فعليًا في تجربة العرض.
          </label>
          <div className="partner-action-row">
            <button className="button primary" disabled={blocked || !reviewed}>
              تأكيد الإقرار
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={blocked}
              onClick={() => setTarget(null)}
            >
              تراجع
            </button>
          </div>
        </form>
      )}
      {!view ? (
        <p role="status">جارٍ تحميل الصرف…</p>
      ) : (
        <>
          {ops && (
            <>
              <h3>أجور متاحة للحجز</h3>
              {!view.eligible.length && (
                <p className="scope-note">
                  لا توجد أجور موجبة غير محجوزة. الأجور التي لم يحدد اتفاقها لا تُصرف.
                </p>
              )}
              {view.eligible.map((e) => (
                <div className="site-item" key={e.shipmentId}>
                  <div>
                    <strong>{e.beneficiaryName}</strong>
                    <p>
                      {e.reference} · {cashMoney(e.amountMinor)}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={
                      blocked || !view.balance || view.balance.availableMinor < e.amountMinor
                    }
                    onClick={() => open({ action: 'reserve', ...e })}
                  >
                    حجز الأجر
                  </button>
                </div>
              ))}
            </>
          )}
          <h3>دفعات الأجور</h3>
          {!view.rows.length && <p className="scope-note">لا توجد دفعات ضمن نطاق حسابك.</p>}
          {view.rows.map((p) => (
            <div className="partner-payment-card" key={p.id}>
              <div>
                <strong>
                  {p.beneficiaryName} · {cashMoney(p.amountMinor)}
                </strong>
                <p>
                  {p.reference} · {labels[p.status]}
                </p>
                {p.issueOpen && <p className="alert">فرق مفتوح — لم تُشطب العهدة</p>}
              </div>
              <div className="partner-action-row">
                {(ops
                  ? p.status === 'reserved'
                    ? ['release', 'cancel']
                    : p.status === 'released' && p.returnRequested
                      ? ['receive_return']
                      : p.status === 'received' && p.recoveryRequested
                        ? ['receive_recovery']
                        : []
                  : p.status === 'released' && !p.returnRequested
                    ? ['confirm', 'report_issue', 'request_return']
                    : p.status === 'received' && !p.recoveryRequested
                      ? ['request_recovery']
                      : []
                ).map((action) => (
                  <button
                    key={action}
                    className="button secondary"
                    disabled={blocked}
                    onClick={() => open({ action: action as PartnerAction, row: p })}
                  >
                    {partnerActions[action as PartnerAction]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="scope-note">
            حد عرض الدفعات والأجور المتاحة: {view.displayLimit}. أرصدة الصندوق تشمل جميع القيود.
          </p>
          <details>
            <summary>سجل الإقرارات المالية</summary>
            {view.history.map((e) => (
              <div className="site-item" key={e.id}>
                <div>
                  <strong>
                    {e.actorName} ·{' '}
                    {e.action === 'funding'
                      ? 'تمويل'
                      : e.action === 'reserve'
                        ? 'حجز'
                        : (partnerActions[e.action as PartnerAction] ?? e.action)}
                  </strong>
                  <p>
                    {e.reference} · {e.reason}
                    {e.details.amountMinor !== undefined
                      ? ` · ${cashMoney(e.details.amountMinor)}`
                      : ''}
                  </p>
                </div>
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
