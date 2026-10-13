export function QuickChoices({
  label,
  value,
  choices,
  onChange,
  maxLength = 240,
}: {
  label: string;
  value: string;
  choices: string[];
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <div className="quick-input">
      <span className="quick-label">{label}</span>
      <div className="quick-options" role="group" aria-label="الخيارات الجاهزة">
        {choices.map((choice) => (
          <button
            type="button"
            key={choice}
            aria-pressed={value === choice}
            onClick={() => onChange(choice)}
          >
            {choice}
          </button>
        ))}
      </div>
      <label className="quick-custom">
        تفصيل آخر أو تعديل الاختيار
        <textarea
          aria-label={label}
          value={value}
          maxLength={maxLength}
          required
          minLength={maxLength === 500 ? 5 : 3}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
        />
      </label>
    </div>
  );
}
export function ReferenceInput({
  label,
  value,
  onChange,
  maxLength = 100,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <div className="quick-reference">
      <input
        aria-label={label}
        value={value}
        required
        minLength={3}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="button secondary"
        onClick={() => onChange(`ACK-${crypto.randomUUID().slice(0, 12)}`)}
      >
        إنشاء مرجع إقرار داخلي
      </button>
      <small>مرجع النظام يوثّق إقرارك. إذا لديك إيصال خارجي يمكنك كتابة رقمه.</small>
    </div>
  );
}
export function FullAmount({
  minor,
  onChange,
}: {
  minor: number;
  onChange: (value: string) => void;
}) {
  return (
    <button type="button" className="quick-amount" onClick={() => onChange(String(minor / 100))}>
      استخدام كامل المبلغ · {new Intl.NumberFormat('ar-SY').format(minor / 100)} ل.س
    </button>
  );
}
