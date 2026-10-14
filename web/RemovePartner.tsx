import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
export function RemovePartner({
  kind,
  id,
  name,
  version,
  onRemoved,
}: {
  kind: 'sites' | 'couriers';
  id: string;
  name: string;
  version: number;
  onRemoved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="button secondary remove-partner"
        aria-label={'حذف ' + name}
        onClick={() => setOpen(true)}
      >
        حذف
      </button>
      {open && (
        <RemoveConfirmation
          kind={kind}
          id={id}
          name={name}
          version={version}
          onClose={() => setOpen(false)}
          onRemoved={onRemoved}
        />
      )}
    </>
  );
}
function RemoveConfirmation({
  kind,
  id,
  name,
  version,
  onClose,
  onRemoved,
}: {
  kind: 'sites' | 'couriers';
  id: string;
  name: string;
  version: number;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    key = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError('');
    let committed = saved;
    try {
      if (!saved) {
        await api('/api/network/' + kind + '/' + id, {
          method: 'DELETE',
          headers: { 'idempotency-key': key.current },
          body: JSON.stringify({ expectedVersion: version }),
        });
        committed = true;
        setSaved(true);
      }
      await onRemoved();
      onClose();
    } catch (e) {
      setError(
        committed
          ? 'تمت الإزالة؛ تعذر تحديث القائمة. أعد تحديث العرض.'
          : e instanceof Error
            ? e.message
            : 'تعذرت الإزالة',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="partner-dialog"
      ref={ref}
      aria-labelledby="remove-partner-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="remove-partner-title">إزالة {name} من الشبكة؟</h2>
      <p className="scope-note">
        سيُخفى من قائمة الشركاء ويتوقف عن استقبال أعمال جديدة. تُحفظ سجلات التوصيل والتقييمات
        والحسابات السابقة. وجود مهام أو عهدة أو مخزون غير مسوّى يمنع الإزالة.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          className="button primary remove-partner-confirm"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? 'جارٍ الإزالة…' : saved ? 'تحديث القائمة' : 'تأكيد الإزالة'}
        </button>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          تراجع
        </button>
      </div>
    </dialog>
  );
}
