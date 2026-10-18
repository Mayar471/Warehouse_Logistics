import { useEffect, useState } from 'react';
import type { Account } from '../shared/contracts.js';
import { api } from './api.js';
import { ExecutionEarnings } from './ExecutionEarnings.js';
import { PartnerPayments } from './PartnerPayments.js';
import { Disputes } from './Disputes.js';
import { Notifications, focusNotificationTarget } from './Notifications.js';
export function CompanyPortal({
  account,
  accounts,
  onSwitch,
}: {
  account: Account;
  accounts: Account[];
  onSwitch: (id: string) => void;
}) {
  const [target, setTarget] = useState<{ id: string; stamp: number } | null>(null);
  const [couriers, setCouriers] = useState<
      { id: string; name: string; vehicle: string; available: boolean; archived: boolean }[]
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    void api<{ couriers: typeof couriers }>('/api/company-portal')
      .then((v) => setCouriers(v.couriers))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="app-shell company-portal-shell">
      <main className="company-portal" dir="rtl">
        <header className="panel">
          <p className="eyebrow">الشبكة اللوجستية · بوابة مكتب التوصيل</p>
          <h1>{account.name}</h1>
          <Notifications
            identity={account.id}
            onOpen={(n) => {
              if (n.kind === 'dispute') {
                setTarget({ id: n.targetId, stamp: Date.now() });
                focusNotificationTarget(n.targetId);
              }
            }}
          />
          <p>أجور المكتب وإقرارات استلامها. أجور مندوبي المكتب تُسوّى معه فقط.</p>
          <label>
            تبديل حساب العرض
            <select value={account.id} onChange={(e) => onSwitch(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <section className="panel">
          <h2>مندوبو المكتب</h2>
          {!couriers.length && <p>لا يوجد مندوبون مرتبطون بهذا المكتب.</p>}
          {couriers.map((c) => (
            <div className="site-item" key={c.id}>
              <strong>{c.name}</strong>
              <span>
                {c.vehicle} · {c.archived ? 'مؤرشف' : c.available ? 'متاح' : 'غير متاح'}
              </span>
            </div>
          ))}
        </section>
        <PartnerPayments account={account} />
        <ExecutionEarnings />
        <Disputes account={account} target={target} />
      </main>
    </div>
  );
}
