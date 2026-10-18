export interface OpeningInterval {
  start: string;
  end: string;
}
export interface PickupSchedule {
  mode: 'always' | 'weekly';
  days: { day: number; intervals: OpeningInterval[] }[];
  exceptions: { date: string; intervals: OpeningInterval[]; reason: string }[];
}
export interface OpeningStatus {
  openNow: boolean;
  timeZone: 'Asia/Damascus';
  localDate: string;
  localTime: string;
  label: string;
  closesAt: string | null;
}
export const defaultPickupSchedule = (): PickupSchedule => ({
  mode: 'always',
  days: [],
  exceptions: [],
});
export const weekDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const damascusTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
// Inputs are validated on the server. Intervals use [start,end), with 24:00 allowed only as an end.
export function pickupOpening(schedule: PickupSchedule, now: number): OpeningStatus {
  const values = Object.fromEntries(
    damascusTime.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  const localDate = `${values.year}-${values.month}-${values.day}`,
    localTime = `${values.hour}:${values.minute}`;
  const exception = schedule.exceptions.find((e) => e.date === localDate);
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  const intervals = exception
    ? exception.intervals
    : schedule.mode === 'always'
      ? [{ start: '00:00', end: '24:00' }]
      : (schedule.days.find((d) => d.day === day)?.intervals ?? []);
  const current = intervals.find((i) => i.start <= localTime && localTime < i.end);
  return {
    openNow: !!current,
    timeZone: 'Asia/Damascus',
    localDate,
    localTime,
    closesAt: current?.end ?? null,
    label: current
      ? `مفتوحة الآن حتى ${current.end} بتوقيت دمشق`
      : exception
        ? 'مغلقة الآن وفق استثناء اليوم'
        : 'مغلقة الآن خارج ساعات العمل',
  };
}
