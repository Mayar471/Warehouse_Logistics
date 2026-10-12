# عقد API الشريحة الأولى

هذه وثيقة للقدرات المنفذة فقط؛ النطاق هو طرد جاهز محلي، دون مخزون أو COD أو تكامل Tendsy فعلي.

## هوية التطبيق

`Authorization: Bearer <application key>` و`X-Merchant-Id` لمتجر يملكه التطبيق وفق منح محددة في النسخة التجريبية. المفتاح خارج المتصفح داخل `.local/secrets.json`؛ يستخدمه خادم التطبيق التجريبي.

| الطريقة والمسار | الغرض |
|---|---|
| POST /api/v1/quotes | عرض خدمة مع مدخلات الطرد والمنشأ والوجهة |
| POST /api/v1/fulfillments | تأكيد عرض باستخدام quoteId وIdempotency-Key |
| GET /api/v1/fulfillments/:id | استعلام مقيد بمتجر التطبيق |

المدخلات: `externalReference`, `originId`, `recipientName`, `destination`, `weightKg`. لا تقبل حقول مالية أو حالة يفرضها العميل. الوجهة التجريبية تشترط ذكر دمشق؛ التحقق المكاني والعنوان المنظم ضمن شريحة الشبكة اللاحقة.

العرض صالح عشر دقائق، ولا يحجز سعة مندوب. عند الإنشاء يُفحص العرض واستهلاكه ومرجع طلب البيع، وتُنشأ الشحنة والحدث داخل معاملة. يعاد الطلب نفسه بنفس نتيجة الإنشاء، ويتعارض المحتوى المختلف مع المفتاح نفسه.

## جلسة واجهات التشغيل

| الطريقة والمسار | الغرض |
|---|---|
| GET /api/demo/accounts | حسابات التجربة |
| POST /api/demo/session | دخول حساب عرض مخصص عبر host محلي |
| DELETE /api/session | إلغاء الجلسة |
| GET /api/bootstrap | بيانات حساب المستخدم وشحناته ومواقع نطاقه |
| GET /api/shipments/:id | تفاصيل مقيدة بالصلاحيات وتاريخ |
| POST /api/shipments/:id/actions | إجراء مع expectedVersion وIdempotency-Key |
| GET /api/tracking/:token | تتبع عام قليل البيانات، دون مستلم أو عنوان خاص |

الجلسة HttpOnly وSameSite Strict، وثماني ساعات. وضع العرض وحده متاح؛ مدخل حسابات العرض ليس عقد مصادقة الإنتاج.

### انتقالات الحالات والصلاحيات

| الإجراء | قبل | بعد | من ينفذه |
|---|---|---|---|
| assign | ready | assigned | المشغل، بعد توفر المندوب والسعة |
| accept | assigned دون قبول | assigned مع قبول | المندوب المكلف |
| pickup | assigned مع قبول | picked_up | المندوب المكلف |
| depart | picked_up | in_transit | المندوب المكلف |
| deliver | in_transit | delivered | المندوب المكلف، إقرار تجريبي |
| fail | in_transit | failed | المندوب المكلف، سبب مطلوب |
| cancel | ready أو assigned | cancelled | المتجر صاحب الشحنة أو المشغل |
| return | picked_up أو in_transit أو failed | returning | المشغل، سبب مطلوب |
| receive_return | returning | returned | المشغل، تأكيد استلام المنشأ |

يزيد الإصدار مع كل إجراء مؤثر، بما فيه قبول المهمة. رفض الإصدار القديم 409، والوصول إلى شحنة خارج نطاق المستخدم 404، والإجراء غير المخول 403. إلغاء طرد في النقل يعيد `RETURN_REQUIRED`.

## مختبر الإشعارات

قراءة `/api/integration` وتوقيف المستقبل أو استئنافه عبر `/api/integration/receiver` وطلب محاولة المعلق عبر `/api/integration/flush` متاحة للمشغل فقط. لا وجهات خارجية قابلة للتعديل.

المستقبل `/api/demo-commerce/webhook` يتطلب `X-Webhook-Timestamp` و`X-Webhook-Signature`:

`HMAC-SHA256(key, timestamp + '.' + JSON.stringify(body))`

يسمح بانحراف توقيت خمس دقائق. معرف حدث مستقل وإصدار للشحنة، وإزالة تكرار في المستقبل، وتحديث projection فقط عند إصدار أحدث. عامل الخلفية HTTP يعيد المحاولة بتراجع زمني؛ لا يحمل payload أسماء أو عناوين.

## الأخطاء

جسم الخطأ يحتوي `code`, `message`, `requestId`، ويضيف أخطاء حقول عند التحقق. لا تُعاد أخطاء SQL أو أسرار في استجابة المتصفح. كل endpoint يخضع لحد جسم 16KiB وحد طلبات محلي، وليس ذلك بديلًا عن سياسة إنتاج لكل تطبيق وإجراء.
