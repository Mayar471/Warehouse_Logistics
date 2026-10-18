export const disputeTopics = {
  delay: 'تأخير في التنفيذ',
  delivery: 'مشكلة في التسليم',
  damage: 'تلف البضاعة',
  missing: 'فقد أو نقص',
  cash_difference: 'فرق نقدي',
  payment: 'متابعة صرف الأجر',
  other: 'متابعة أخرى',
} as const;
export const disputeStates = {
  open: 'جديدة',
  waiting_reply: 'بانتظار رد',
  under_review: 'قيد المراجعة',
  resolved: 'قرار موثّق',
  closed: 'أغلقت المتابعة',
} as const;
export const disputeDecisions = {
  operational_guidance: 'توجيه تشغيلي',
  referred_finance: 'إحالة للمعالجة المالية',
  data_correction_required: 'طلب تصحيح بإجراء مستقل',
  no_action: 'لا يلزم إجراء إضافي',
} as const;
export type DisputeSubject = 'shipment' | 'transfer' | 'partner_payment';
export interface DisputeCase {
  id: string;
  reference: string;
  subjectKind: DisputeSubject;
  subjectId: string;
  subjectReference: string;
  topic: keyof typeof disputeTopics;
  summary: string;
  status: keyof typeof disputeStates;
  version: number;
  assigneeId: string;
  assigneeName: string;
  dueAt: string;
  overdue: boolean;
  escalatedAt: string | null;
  decision: keyof typeof disputeDecisions | null;
  decisionText: string | null;
  createdAt: string;
  updatedAt: string;
  createdByMe: boolean;
  waitingForMe: boolean;
  waitingForId: string | null;
}
export interface DisputeDetail {
  case: DisputeCase;
  canManage: boolean;
  canClose: boolean;
  participants: { id: string; name: string; role: string }[];
  events: {
    id: string;
    action: string;
    actorName: string;
    text: string;
    visibility: 'shared' | 'internal';
    createdAt: string;
  }[];
}
