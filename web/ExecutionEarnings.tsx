import { useEffect, useState } from 'react';
import { api } from './api.js';
import { cashMoney } from './Cash.js';
type View = {
  rows: {
    shipmentId: string;
    reference: string;
    beneficiaryName: string;
    companyId: string | null;
    rateBps: number | null;
    feeMinor: number;
    amountMinor: number | null;
    earnedAt: string;
  }[];
  groups: {
    beneficiaryId: string;
    beneficiaryName: string;
    kind: string;
    tasks: number;
    unconfigured: number;
    amountMinor: number;
  }[];
};
export function ExecutionEarnings() {
  const [view, setView] = useState<View | null>(null),
    [error, setError] = useState('');
  async function load() {
    try {
      setView(await api<View>('/api/execution-earnings'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الأجور');
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>أجور تنفيذ التوصيل</h2>
          <p>نسبة اتفاق الشريك عند الإسناد × رسوم التوصيل فقط؛ قيمة البضائع مستبعدة.</p>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          تحديث الأجور
        </button>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <p className="scope-note">
        هذه أجور مستحقة محسوبة، وليست مبالغ صُرفت. الصرف والإقرار المستقل لا يزالان بحاجة تنفيذ. عدم
        تحديد النسبة يبقي المبلغ غير محسوب.
      </p>
      {!view ? (
        <p role="status">جارٍ التحميل…</p>
      ) : (
        <>
          {view.groups.map((g) => (
            <div className="site-item" key={g.kind + g.beneficiaryId}>
              <div>
                <strong>{g.beneficiaryName}</strong>
                <p>
                  {g.tasks} مهمة · {cashMoney(g.amountMinor)} محسوبة · {g.unconfigured} مهمة بلا
                  اتفاق نسبة
                </p>
              </div>
            </div>
          ))}
          {!view.rows.length && (
            <p className="scope-note">
              لا توجد أجور تنفيذ مسجلة بعد. اضبط نسبة الشريك ثم أسند طلبًا جديدًا وأكمل التوصيل.
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>الشحنة</th>
                  <th>جهة الاستحقاق</th>
                  <th>رسوم التوصيل</th>
                  <th>نسبة الاتفاق</th>
                  <th>الأجر المستحق</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.shipmentId}>
                    <td dir="ltr">{r.reference}</td>
                    <td>
                      {r.beneficiaryName} · {r.companyId ? 'مكتب' : 'مستقل'}
                    </td>
                    <td>{cashMoney(r.feeMinor)}</td>
                    <td>{r.rateBps === null ? 'غير محددة' : r.rateBps / 100 + '%'}</td>
                    <td>{r.amountMinor === null ? 'غير محسوب' : cashMoney(r.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
