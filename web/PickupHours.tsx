import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  defaultPickupSchedule,
  weekDays,
  type PickupSchedule,
  type OpeningInterval,
  type OpeningStatus,
} from '../shared/pickup-hours.js';
import { api, key } from './api.js';
type View = { version: number; schedule: PickupSchedule; status: OpeningStatus };
function Intervals({
  value,
  onChange,
  label,
}: {
  value: OpeningInterval[];
  onChange: (v: OpeningInterval[]) => void;
  label: string;
}) {
  return (
    <div className="opening-intervals">
      <label className="opening-toggle">
        <input
          type="checkbox"
          checked={value.length > 0}
          onChange={(e) => onChange(e.target.checked ? [{ start: '09:00', end: '18:00' }] : [])}
        />
        مفتوح
      </label>
      {value.map((i, index) => (
        <div className="opening-interval" key={index}>
          <label>
            من
            <input
              type="time"
              aria-label={`${label} بداية ${index + 1}`}
              required
              value={i.start}
              onChange={(e) =>
                onChange(value.map((v, n) => (n === index ? { ...v, start: e.target.value } : v)))
              }
            />
          </label>
          <label>
            إلى
            <input
              type="time"
              aria-label={`${label} نهاية ${index + 1}`}
              required={i.end !== '24:00'}
              disabled={i.end === '24:00'}
              value={i.end === '24:00' ? '' : i.end}
              onChange={(e) =>
                onChange(value.map((v, n) => (n === index ? { ...v, end: e.target.value } : v)))
              }
            />
          </label>
          <button
            type="button"
            className="button secondary"
            aria-pressed={i.end === '24:00'}
            onClick={() =>
              onChange(
                value.map((v, n) =>
                  n === index ? { ...v, end: i.end === '24:00' ? '18:00' : '24:00' } : v,
                ),
              )
            }
          >
            {i.end === '24:00' ? 'حتى 24:00 ✓' : 'نهاية اليوم'}
          </button>
          {index > 0 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => onChange(value.filter((_, n) => n !== index))}
            >
              حذف الفترة
            </button>
          )}
        </div>
      ))}
      {value.length === 1 && value[0].end < '23:00' && (
        <button
          type="button"
          className="button secondary"
          onClick={() => onChange([...value, { start: value[0].end, end: '23:00' }])}
        >
          إضافة فترة ثانية
        </button>
      )}
    </div>
  );
}
export function PickupHours({
  siteId,
  editable = false,
  onSaved,
}: {
  siteId: string;
  editable?: boolean;
  onSaved?: () => Promise<void>;
}) {
  const [view, setView] = useState<View | null>(null),
    [schedule, setSchedule] = useState<PickupSchedule>(defaultPickupSchedule()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState(''),
    [saved, setSaved] = useState(false);
  const pending = useRef<{ body: string; key: string } | null>(null),
    submitting = useRef(false);
  async function load() {
    const v = await api<View>(`/api/network/pickup-sites/${siteId}/hours`);
    setView(v);
    setSchedule(v.schedule);
    setDate(v.status.localDate);
    setError('');
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [siteId]);
  const weekly = () =>
    Array.from({ length: 7 }, (_, day) => ({
      day,
      intervals: day === 5 ? [] : [{ start: '09:00', end: '18:00' }],
    }));
  function updateIntervals(day: number, intervals: OpeningInterval[]) {
    setSchedule((s) => ({
      ...s,
      days: s.days.map((d) => (d.day === day ? { ...d, intervals } : d)),
    }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!view || submitting.current || saved) return;
    const invalid = [...schedule.days, ...schedule.exceptions].some((d) =>
      d.intervals.some((i, n) => i.start >= i.end || (n > 0 && i.start < d.intervals[n - 1].end)),
    );
    if (invalid) {
      setError(
        'راجع الفترات: وقت النهاية يجب أن يأتي بعد البداية، والفترة الثانية لا تتداخل مع الأولى.',
      );
      return;
    }
    const body = JSON.stringify({
      expectedVersion: view.version,
      schedule,
      reason: 'تحديث ساعات العمل والإغلاقات الاستثنائية',
    });
    if (pending.current?.body !== body) pending.current = { body, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/api/network/pickup-sites/${siteId}/hours`, {
        method: 'PUT',
        headers: { 'idempotency-key': pending.current.key },
        body,
      });
      setSaved(true);
      await onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر حفظ الدوام');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (!view)
    return (
      <section>
        <p role="status">جارٍ تحميل الدوام…</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button
          className="button secondary"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          إعادة التحميل
        </button>
      </section>
    );
  if (!editable)
    return (
      <section className="panel pickup-hours-read">
        <h2>ساعات عمل نقطتك</h2>
        <p>{view.status.label}</p>
        <p>
          التوقيت: دمشق. الدوام{' '}
          {schedule.mode === 'always' ? 'مستمر طوال اليوم' : 'وفق الجدول الأسبوعي'}. إغلاق النقطة لا
          يلغي عهدة الطرود الموجودة.
        </p>
        {schedule.mode === 'weekly' && (
          <ul>
            {schedule.days.map((d) => (
              <li key={d.day}>
                {weekDays[d.day]}:{' '}
                {d.intervals.length
                  ? d.intervals.map((i) => `${i.start} – ${i.end}`).join('، ')
                  : 'مغلق'}
              </li>
            ))}
          </ul>
        )}
        {schedule.exceptions.length > 0 && (
          <details>
            <summary>استثناءات الدوام</summary>
            {schedule.exceptions.map((e) => (
              <p key={e.date}>
                {e.date}:{' '}
                {e.intervals.length
                  ? e.intervals.map((i) => `${i.start} – ${i.end}`).join('، ')
                  : 'مغلق'}{' '}
                · {e.reason}
              </p>
            ))}
          </details>
        )}
        <button
          className="button secondary"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          تحديث الدوام
        </button>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <form className="pickup-hours-form" onSubmit={submit}>
      <p className="scope-note">
        جميع الساعات بتوقيت دمشق. بداية الفترة مشمولة ونهايتها غير مشمولة. للدوام الذي يتجاوز منتصف
        الليل أضف فترة لكل يوم. الاستثناء يحل محل جدول يومه كاملًا.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">حُفظ الدوام. أغلق النافذة وحدّث الشبكة إذا تعذر تحديث عرضها.</p>}
      <fieldset disabled={busy || saved}>
        <legend>الدوام الأساسي</legend>
        <div className="hours-presets">
          <button
            type="button"
            className="button secondary"
            aria-pressed={schedule.mode === 'always'}
            onClick={() => setSchedule((s) => ({ ...s, mode: 'always', days: [] }))}
          >
            مفتوح 24 ساعة
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={schedule.mode === 'weekly'}
            onClick={() =>
              setSchedule((s) => ({
                ...s,
                mode: 'weekly',
                days: s.days.length ? s.days : weekly(),
              }))
            }
          >
            جدول أسبوعي
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setSchedule((s) => ({ ...s, mode: 'weekly', days: weekly() }))}
          >
            09–18 والجمعة عطلة
          </button>
        </div>
        {schedule.mode === 'weekly' && (
          <>
            {schedule.days.map((d) => (
              <details className="opening-day" key={d.day}>
                <summary>
                  <strong>{weekDays[d.day]}</strong>
                  <span dir="ltr">
                    {d.intervals.length
                      ? d.intervals.map((i) => `${i.start} – ${i.end}`).join(' / ')
                      : 'مغلق'}
                  </span>
                  <span className="hours-edit">تعديل ⌄</span>
                </summary>
                <Intervals
                  label={weekDays[d.day]}
                  value={d.intervals}
                  onChange={(v) => updateIntervals(d.day, v)}
                />
              </details>
            ))}
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                setSchedule((s) => ({
                  ...s,
                  days: s.days.map((d) => ({
                    ...d,
                    intervals: s.days.find((v) => v.day === 0)!.intervals.map((i) => ({ ...i })),
                  })),
                }))
              }
            >
              تطبيق دوام الأحد على جميع الأيام
            </button>
          </>
        )}
      </fieldset>
      <fieldset disabled={busy || saved}>
        <legend>إغلاقات ودوام استثنائي</legend>
        <label>
          تاريخ الاستثناء
          <input
            type="date"
            aria-label="تاريخ الاستثناء"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={
            !date ||
            schedule.exceptions.length >= 90 ||
            schedule.exceptions.some((e) => e.date === date)
          }
          onClick={() =>
            setSchedule((s) => ({
              ...s,
              exceptions: [...s.exceptions, { date, intervals: [], reason: 'إغلاق استثنائي' }].sort(
                (a, b) => a.date.localeCompare(b.date),
              ),
            }))
          }
        >
          إضافة استثناء لليوم المحدد
        </button>
        {schedule.exceptions.map((ex) => (
          <div className="opening-day" key={ex.date}>
            <strong dir="ltr">{ex.date}</strong>
            <label>
              نوع الاستثناء
              <select
                value={ex.reason}
                onChange={(e) =>
                  setSchedule((s) => ({
                    ...s,
                    exceptions: s.exceptions.map((v) =>
                      v.date === ex.date ? { ...v, reason: e.target.value } : v,
                    ),
                  }))
                }
              >
                {[
                  ...new Set(['إغلاق استثنائي', 'عطلة رسمية', 'صيانة', 'دوام إضافي', ex.reason]),
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <Intervals
              label={ex.date}
              value={ex.intervals}
              onChange={(intervals) =>
                setSchedule((s) => ({
                  ...s,
                  exceptions: s.exceptions.map((v) =>
                    v.date === ex.date ? { ...v, intervals } : v,
                  ),
                }))
              }
            />
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                setSchedule((s) => ({
                  ...s,
                  exceptions: s.exceptions.filter((e) => e.date !== ex.date),
                }))
              }
            >
              حذف الاستثناء
            </button>
          </div>
        ))}
      </fieldset>
      <div className="partner-action-row">
        <button className="button primary" disabled={busy || saved}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ الدوام'}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setSaved(false);
            void load().catch((e) => setError(e.message));
          }}
        >
          تحديث وإعادة تحميل الدوام
        </button>
      </div>
    </form>
  );
}
