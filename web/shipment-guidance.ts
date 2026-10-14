import type { Shipment } from '../shared/contracts.js';

// Guidance explains the recorded state; command eligibility stays in the existing action panel.
export function shipmentGuidance(s: Shipment): { next: string; owner: string } {
  switch (s.status) {
    case 'ready':
      return {
        next:
          s.originHandoverRequired && !s.originPrepared
            ? 'تجهيز الطرد وإسناد المندوب'
            : 'إسناد مندوب للتوصيل',
        owner:
          s.originHandoverRequired && !s.originPrepared ? 'المتجر والعمليات' : 'إدارة العمليات',
      };
    case 'assigned':
      if (!s.assignmentAccepted)
        return { next: 'قبول المهمة قبل انتهاء المهلة', owner: s.courierName ?? 'المندوب' };
      if (s.originHandoverRequired && !s.originReleased)
        return {
          next: s.originPrepared ? 'تسليم الطرد للمندوب' : 'تجهيز الطرد ثم تسليمه للمندوب',
          owner: s.originName,
        };
      return { next: 'تأكيد استلام الطرد من المنشأ', owner: s.courierName ?? 'المندوب' };
    case 'picked_up':
      return { next: 'بدء التوصيل', owner: s.courierName ?? 'المندوب' };
    case 'in_transit':
      return {
        next: s.pickupSiteId
          ? 'تأكيد الوصول إلى نقطة الاستلام'
          : s.deliveryProofRequired
            ? 'تسليم العميل والتحقق من رمز الاستلام'
            : 'تأكيد تسليم الطرد للعميل',
        owner: s.courierName ?? 'المندوب',
      };
    case 'awaiting_handover':
      return { next: 'تأكيد استلام العهدة من المندوب', owner: s.pickupSiteName ?? 'نقطة الاستلام' };
    case 'ready_for_pickup':
      return { next: 'استلام العميل خلال المهلة المحددة', owner: 'العميل ونقطة الاستلام' };
    case 'pickup_expired':
      return { next: 'إسناد مندوب لإعادة الطرد', owner: 'إدارة العمليات' };
    case 'returning':
      return {
        next: s.custodySiteId
          ? !s.assignmentAccepted
            ? 'قبول مهمة الإرجاع'
            : 'تسليم الطرد من النقطة لمندوب الإرجاع'
          : 'إعادة الطرد وتأكيد استلام المنشأ',
        owner:
          s.custodySiteId && s.assignmentAccepted
            ? (s.pickupSiteName ?? 'نقطة الاستلام')
            : (s.courierName ?? 'إدارة العمليات'),
      };
    case 'failed':
      return { next: 'مراجعة التعذر وتحديد مسار الإرجاع', owner: 'إدارة العمليات' };
    case 'delivered':
      return { next: 'اكتمل تسليم الطلب', owner: 'لا يوجد إجراء توصيل مطلوب' };
    case 'returned':
      return { next: 'اكتمل إرجاع الطرد إلى المنشأ', owner: 'المتجر' };
    case 'cancelled':
      return { next: 'أُغلقت الشحنة بالإلغاء', owner: 'لا يوجد إجراء توصيل مطلوب' };
  }
}
