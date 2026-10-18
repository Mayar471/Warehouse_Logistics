import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Account } from '../shared/contracts.js';
import {
  disputeTopics,
  disputeStates,
  disputeDecisions,
  type DisputeCase,
  type DisputeDetail,
  type DisputeSubject,
} from '../shared/disputes.js';
import { api, key } from './api.js';
type Target = { id: string; stamp: number };
type Subject = { id: string; reference: string };
const subjectNames = {
  shipment: 'طلب أو شحنة',
  transfer: 'نقل بين المواقع',
  partner_payment: 'دفعة أجر تنفيذ',
};
const actions = {
  reply: 'إرسال رد',
  internal_note: 'ملاحظة داخلية للعمليات',
  assign: 'تحديد المسؤول والمهلة',
  request_reply: 'طلب رد طرف',
  escalate: 'رفع أولوية المتابعة',
  resolve: 'توثيق القرار',
  reopen: 'اعتراض وإعادة المراجعة',
  close: 'قبول القرار وإغلاق المتابعة',
};
const defaults: Partial<Record<keyof typeof actions, string>> = {
  assign: 'إسناد المتابعة بالمهلة المحددة.',
  request_reply: 'يرجى مراجعة تفاصيل الحالة وإرسال ردكم.',
  escalate: 'أطلب إعطاء الحالة أولوية متابعة أعلى.',
  reopen: 'أعترض على القرار وأطلب إعادة مراجعة الحالة.',
  close: 'اطلعت على القرار وأؤكد إغلاق المتابعة.',
};
export function Disputes({
  account,
  customer = false,
  target,
  preset,
}: {
  account?: Account;
  customer?: boolean;
  target?: Target | null;
  preset?: { kind: DisputeSubject; id: string; reference: string };
}) {
  const prefix = customer ? '/api/storefront/disputes' : '/api/disputes',
    operator = account?.role === 'operator';
  const [view, setView] = useState<{
      rows: DisputeCase[];
      total: number;
      stats: { active: number; overdue: number; escalated: number };
      operators: Account[];
    } | null>(null),
    [detail, setDetail] = useState<DisputeDetail | null>(null),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [state, setState] = useState('active'),
    [attention, setAttention] = useState('all'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const [creating, setCreating] = useState(!!preset),
    [kind, setKind] = useState<DisputeSubject>(
      preset?.kind ?? (account?.role === 'company' ? 'partner_payment' : 'shipment'),
    ),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [subject, setSubject] = useState(preset?.id ?? ''),
    [subjectSearch, setSubjectSearch] = useState(''),
    [topic, setTopic] = useState<keyof typeof disputeTopics>('delay'),
    [summary, setSummary] = useState('');
  const [action, setAction] = useState<keyof typeof actions>('reply'),
    [text, setText] = useState(''),
    [assignee, setAssignee] = useState(''),
    [hours, setHours] = useState(24),
    [participant, setParticipant] = useState(''),
    [decision, setDecision] = useState<keyof typeof disputeDecisions>('operational_guidance');
  const pending = useRef<{ body: string; url: string; key: string } | null>(null),
    submitting = useRef(false);
  const initialPreset = useRef(preset),
    detailElement = useRef<HTMLElement>(null);
  const listGeneration = useRef(0),
    detailGeneration = useRef(0),
    selectedRef = useRef(selected),
    criteriaRef = useRef('');
  selectedRef.current = selected;
  criteriaRef.current = new URLSearchParams({
    state,
    attention,
    search,
    page: String(page),
  }).toString();
  useEffect(() => {
    if (detail?.case.id)
      detailElement.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [detail?.case.id]);
  async function load() {
    const q = new URLSearchParams({ state, attention, search, page: String(page) });
    const generation = ++listGeneration.current,
      result = await api<NonNullable<typeof view>>(prefix + '?' + q);
    if (generation === listGeneration.current && q.toString() === criteriaRef.current)
      setView(result);
  }
  async function loadDetail(id = selected) {
    if (id) {
      const generation = ++detailGeneration.current;
      const next = await api<DisputeDetail>(prefix + '/' + id);
      if (generation !== detailGeneration.current || selectedRef.current !== id) return;
      setDetail(next);
      setAction(next.case.status === 'resolved' ? 'reopen' : 'reply');
      setText(next.case.status === 'resolved' ? (defaults.reopen ?? '') : '');
      setAssignee(next.case.assigneeId);
      setParticipant(next.participants.find((p) => p.role !== 'operator')?.id ?? '');
    }
  }
  useEffect(() => {
    let disposed = false;
    const generation = ++listGeneration.current;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ state, attention, search, page: String(page) });
      void api<NonNullable<typeof view>>(prefix + '?' + q)
        .then((v) => {
          if (!disposed && generation === listGeneration.current) setView(v);
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    }, 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [prefix, state, attention, search, page]);
  useEffect(() => {
    const generation = ++detailGeneration.current;
    if (!selected) {
      setDetail(null);
      return;
    }
    let disposed = false;
    setDetail(null);
    void api<DisputeDetail>(prefix + '/' + selected)
      .then((v) => {
        if (!disposed && generation === detailGeneration.current) {
          setDetail(v);
          setAssignee(v.case.assigneeId);
          setParticipant(v.participants.find((p) => p.role !== 'operator')?.id ?? '');
          setAction(v.case.status === 'resolved' ? 'reopen' : 'reply');
          setText(v.case.status === 'resolved' ? (defaults.reopen ?? '') : '');
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [selected, prefix]);
  useEffect(() => {
    if (target) {
      if (selected === target.id) void loadDetail(target.id).catch((e) => setError(e.message));
      else setSelected(target.id);
    }
  }, [target]);
  useEffect(() => {
    if (!creating) return;
    let disposed = false;
    setSubjects([]);
    setSubject(initialPreset.current?.kind === kind ? initialPreset.current.id : '');
    const timer = setTimeout(() => {
      void api<{ rows: Subject[] }>(
        prefix + '/subjects?' + new URLSearchParams({ kind, search: subjectSearch }),
      )
        .then((v) => {
          if (!disposed) {
            const p = initialPreset.current;
            setSubjects(
              p?.kind === kind && !v.rows.some((r) => r.id === p.id)
                ? [{ id: p.id, reference: p.reference }, ...v.rows]
                : v.rows,
            );
            initialPreset.current = undefined;
          }
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    }, 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [prefix, creating, kind, subjectSearch]);
  function chooseAction(v: keyof typeof actions) {
    setAction(v);
    setText(defaults[v] ?? '');
    setError('');
  }
  async function send(e: FormEvent, create = false) {
    e.preventDefault();
    if (submitting.current || (!create && !detail)) return;
    const url = create ? prefix : `${prefix}/${detail!.case.id}/actions`;
    const body = JSON.stringify(
      create
        ? { subjectKind: kind, subjectId: subject, topic, summary }
        : {
            action,
            expectedVersion: detail!.case.version,
            text,
            ...(action === 'assign' ? { assigneeId: assignee, dueHours: hours } : {}),
            ...(action === 'request_reply' ? { participantId: participant } : {}),
            ...(action === 'resolve' ? { decision } : {}),
          },
    );
    if (pending.current?.body !== body || pending.current.url !== url)
      pending.current = { body, url, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ id: string }>(url, {
        method: 'POST',
        headers: {
          'idempotency-key': pending.current.key,
          'x-dispute-actor': account?.id ?? 'customer',
        },
        body,
      });
      pending.current = null;
      setCreating(false);
      setSummary('');
      setSelected(result.id);
      if (selected === result.id) await loadDetail(result.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر حفظ المتابعة');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const allowedKinds: DisputeSubject[] =
    account?.role === 'company'
      ? ['partner_payment']
      : customer || account?.role === 'pickup'
        ? ['shipment']
        : account?.role === 'merchant'
          ? ['shipment', 'transfer']
          : ['shipment', 'transfer', 'partner_payment'];
  const d = detail?.case,
    available: (keyof typeof actions)[] =
      !d || d.status === 'closed'
        ? []
        : d.status === 'resolved'
          ? [
              ...(detail!.canClose ? ['close' as const] : []),
              'reopen',
              ...(operator ? ['internal_note' as const] : []),
            ]
          : [
              'reply',
              ...((operator || d.overdue) && !d.escalatedAt ? ['escalate' as const] : []),
              ...(operator
                ? (['assign', 'request_reply', 'resolve', 'internal_note'] as const)
                : []),
            ];
  return (
    <section className="panel disputes-workspace" aria-label="المتابعات والنزاعات">
      <div className="panel-title">
        <div>
          <h2>المتابعات والنزاعات</h2>
          <p>حالة واضحة، طرف مسؤول، وردود وقرار موثّق.</p>
        </div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            setCreating((v) => !v);
            setError('');
          }}
        >
          فتح متابعة
        </button>
      </div>
      <p className="scope-note">
        إغلاق المتابعة لا يعني تسوية الأموال أو تغيير عهدة الطرد. أي تصحيح يُنفذ من مساره المختص.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {view && (
        <div className="dispute-metrics">
          {[
            ['نشطة', 'active', 'all'],
            ['تجاوزت المهلة', 'overdue', 'overdue'],
            ['مرفوعة الأولوية', 'escalated', 'escalated'],
          ].map(([label, field, filter]) => (
            <button
              className="partner-balance"
              key={field}
              onClick={() => {
                setState('active');
                setSelected('');
                setAttention(filter);
                setPage(0);
              }}
            >
              <span>{label}</span>
              <strong>{view.stats[field as keyof typeof view.stats]}</strong>
            </button>
          ))}
        </div>
      )}
      {creating && (
        <form className="dispute-form" onSubmit={(e) => void send(e, true)}>
          <h3>متابعة جديدة</h3>
          <p>الوصف والردود المشتركة تظهر للأطراف المعنية بالسجل.</p>
          <fieldset disabled={busy}>
            <label>
              نوع السجل
              <select
                aria-label="نوع السجل"
                value={kind}
                onChange={(e) => setKind(e.target.value as DisputeSubject)}
              >
                {allowedKinds.map((k) => (
                  <option value={k} key={k}>
                    {subjectNames[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              البحث عن السجل
              <input
                maxLength={80}
                value={subjectSearch}
                onChange={(e) => setSubjectSearch(e.target.value)}
                placeholder="مرجع الطلب أو العملية"
              />
            </label>
            <label>
              السجل المرتبط
              <select
                aria-label="السجل المرتبط"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">اختر من سجلات حسابك</option>
                {subjects.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.reference}
                  </option>
                ))}
              </select>
            </label>
            <small>تُعرض حتى 25 نتيجة. البحث يشمل السجلات السابقة المسموح بها لحسابك.</small>
            <label>
              موضوع المتابعة
              <select
                aria-label="موضوع المتابعة"
                value={topic}
                onChange={(e) => setTopic(e.target.value as typeof topic)}
              >
                {Object.entries(disputeTopics).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              وصف المشكلة
              <textarea
                aria-label="وصف المشكلة"
                required
                minLength={5}
                maxLength={2000}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
          </fieldset>
          <button className="button primary" disabled={busy || !subject}>
            تسجيل المتابعة
          </button>
        </form>
      )}
      <div className="dispute-filters">
        <label>
          حالة المتابعة
          <select
            aria-label="حالة المتابعة"
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setSelected('');
              setAttention('all');
              setPage(0);
            }}
          >
            <option value="active">نشطة</option>
            <option value="resolved">قرار موثّق</option>
            <option value="closed">مغلقة</option>
            <option value="all">جميع الحالات</option>
          </select>
        </label>
        <label>
          بحث المتابعات
          <input
            value={search}
            maxLength={80}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="مرجع الحالة أو السجل"
          />
        </label>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            void load()
              .then(() => loadDetail())
              .catch((e) => setError(e.message));
          }}
        >
          تحديث المتابعات
        </button>
      </div>
      <div className="dispute-layout">
        <div className="dispute-list">
          {!view ? (
            <p role="status">جارٍ تحميل المتابعات…</p>
          ) : !view.rows.length ? (
            <p>لا توجد حالات مطابقة ضمن نطاق حسابك.</p>
          ) : (
            view.rows.map((c) => (
              <button
                className={`dispute-list-item ${selected === c.id ? 'selected' : ''}`}
                disabled={busy}
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setError('');
                }}
              >
                <strong>
                  {c.reference} · {disputeTopics[c.topic]}
                </strong>
                <span>{c.subjectReference}</span>
                <small>
                  {disputeStates[c.status]}
                  {c.overdue ? ' · متأخرة' : ''}
                  {c.escalatedAt ? ' · أولوية متابعة أعلى' : ''}
                </small>
              </button>
            ))
          )}
          {view && (
            <div className="partner-action-row">
              <button
                className="button secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                السابق
              </button>
              <span>
                {view.total} حالة · صفحة {page + 1}
              </span>
              <button
                className="button secondary"
                disabled={(page + 1) * 25 >= view.total}
                onClick={() => setPage((p) => p + 1)}
              >
                التالي
              </button>
            </div>
          )}
        </div>
        {detail && d && (
          <article
            className="dispute-detail"
            ref={detailElement}
            tabIndex={-1}
            data-notification-target={d.id}
          >
            <h3>
              {d.reference} · {disputeTopics[d.topic]}
            </h3>
            <p>
              {d.subjectReference} · {disputeStates[d.status]}
            </p>
            <p>{d.summary}</p>
            <div className="scope-note">
              <p>المسؤول: {d.assigneeName}</p>
              <p>
                المهلة: {new Date(d.dueAt).toLocaleString('ar-SY', { timeZone: 'Asia/Damascus' })}{' '}
                بتوقيت دمشق
              </p>
              {d.overdue && <strong>تجاوزت المهلة — تحتاج متابعة</strong>}
              {d.escalatedAt && <p>رُفعت أولوية متابعة هذه الحالة داخل النظام.</p>}
            </div>
            {d.decision && (
              <div className="dispute-decision">
                <strong>{disputeDecisions[d.decision]}</strong>
                <p>{d.decisionText}</p>
              </div>
            )}
            <ol className="dispute-events">
              {detail.events.map((ev) => (
                <li key={ev.id} className={ev.visibility === 'internal' ? 'internal' : ''}>
                  <strong>
                    {ev.actorName}
                    {ev.visibility === 'internal' ? ' · داخلي للعمليات' : ''}
                  </strong>
                  <p>{ev.text}</p>
                  <small>
                    {new Date(ev.createdAt).toLocaleString('ar-SY', { timeZone: 'Asia/Damascus' })}
                  </small>
                </li>
              ))}
            </ol>
            <small>آخر 100 إجراء متاح لحسابك؛ يحتفظ النظام بالسجل الكامل.</small>
            {available.length > 0 && (
              <form className="dispute-form" onSubmit={(e) => void send(e)}>
                <fieldset disabled={busy}>
                  <label>
                    الإجراء
                    <select
                      aria-label="الإجراء"
                      value={available.includes(action) ? action : available[0]}
                      onChange={(e) => chooseAction(e.target.value as keyof typeof actions)}
                    >
                      {available.map((k) => (
                        <option value={k} key={k}>
                          {actions[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {action === 'assign' && (
                    <>
                      <label>
                        مسؤول المتابعة
                        <select
                          aria-label="مسؤول المتابعة"
                          required
                          value={assignee}
                          onChange={(e) => setAssignee(e.target.value)}
                        >
                          {view?.operators.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        مهلة جديدة من الآن
                        <select
                          aria-label="مهلة جديدة من الآن"
                          value={hours}
                          onChange={(e) => setHours(Number(e.target.value))}
                        >
                          <option value={4}>4 ساعات</option>
                          <option value={24}>24 ساعة</option>
                          <option value={72}>72 ساعة</option>
                        </select>
                      </label>
                    </>
                  )}
                  {action === 'request_reply' && (
                    <label>
                      الطرف المطلوب ردّه
                      <select
                        aria-label="الطرف المطلوب ردّه"
                        required
                        value={participant}
                        onChange={(e) => setParticipant(e.target.value)}
                      >
                        <option value="">اختر الطرف</option>
                        {detail.participants
                          .filter((p) => p.role !== 'operator')
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {action === 'resolve' && (
                    <label>
                      نوع القرار
                      <select
                        aria-label="نوع القرار"
                        value={decision}
                        onChange={(e) => setDecision(e.target.value as typeof decision)}
                      >
                        {Object.entries(disputeDecisions).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    {action === 'internal_note'
                      ? 'ملاحظة خاصة بالعمليات'
                      : action === 'resolve'
                        ? 'تفسير القرار للأطراف'
                        : 'الرسالة أو الإقرار'}
                    <textarea
                      aria-label={
                        action === 'internal_note'
                          ? 'ملاحظة خاصة بالعمليات'
                          : action === 'resolve'
                            ? 'تفسير القرار للأطراف'
                            : 'الرسالة أو الإقرار'
                      }
                      required
                      minLength={5}
                      maxLength={2000}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  {action === 'reply' && (
                    <div className="partner-action-row">
                      {['أراجع الحالة وسأوافيكم بالتفاصيل.', 'يرجى توضيح الإجراء المطلوب مني.'].map(
                        (v) => (
                          <button
                            type="button"
                            className="button secondary"
                            key={v}
                            onClick={() => setText(v)}
                          >
                            {v}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </fieldset>
                <button className="button primary" disabled={busy}>
                  حفظ الإجراء
                </button>
              </form>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
