import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import {
  disputeTopics,
  disputeDecisions,
  type DisputeCase,
  type DisputeSubject,
} from '../shared/disputes.js';
import { demoAccounts, type Transaction } from './db.js';
import type { UserNotification } from '../shared/notifications.js';
import { assert, idempotent, transactionGate } from './domain.js';
type Actor = { audience: string; name: string; role: string; account: Account | null };
const subjectKind = z.enum(['shipment', 'transfer', 'partner_payment']);
const text = z.string().trim().min(5).max(2000);
const columns = `d.id,d.reference,d.subject_kind AS "subjectKind",d.subject_id AS "subjectId",d.subject_reference AS "subjectReference",d.topic,d.summary,d.status,d.version,d.assignee_id AS "assigneeId",d.assignee_name AS "assigneeName",d.due_at AS "dueAt",(d.due_at<$2::timestamptz AND d.status NOT IN ('resolved','closed')) AS overdue,d.escalated_at AS "escalatedAt",d.decision,d.decision_text AS "decisionText",d.created_at AS "createdAt",d.updated_at AS "updatedAt",d.waiting_for AS "waitingForId",(d.creator_audience=$1) AS "createdByMe",EXISTS(SELECT 1 FROM dispute_participants w WHERE w.id=d.waiting_for AND w.audience=$1) AS "waitingForMe"`;
export const disputeScope = `($3::boolean OR EXISTS(SELECT 1 FROM dispute_participants p WHERE p.dispute_id=d.id AND p.audience=$1))`;
const audienceOf = (a: Account | string): Actor =>
  typeof a === 'string'
    ? { audience: 'customer:' + a, name: 'العميل', role: 'customer', account: null }
    : { audience: 'account:' + a.id, name: a.name, role: a.role, account: a };
function subjectQuery(a: Actor, kind: DisputeSubject) {
  const role = a.role,
    account = a.account;
  let from = '',
    ref = '',
    scope = 'false AND ($1::text IS NULL OR true)',
    value: string | null = null;
  if (kind === 'shipment') {
    from = 'shipments s LEFT JOIN delivery_service_subjects d ON d.shipment_id=s.id';
    ref = 's.reference';
    if (role === 'operator') scope = '$1::text IS NULL';
    if (role === 'merchant') {
      scope = 's.merchant_id=$1';
      value = account!.merchantId;
    }
    if (role === 'courier') {
      scope = '(s.courier_id=$1 OR d.courier_id=$1)';
      value = account!.courierId;
    }
    if (role === 'pickup') {
      scope = 's.pickup_site_id=$1';
      value = account!.pickupSiteId ?? null;
    }
    if (role === 'customer') {
      scope =
        'EXISTS(SELECT 1 FROM storefront_checkouts c WHERE c.shipment_id=s.id AND c.owner_hash=$1)';
      value = a.audience.slice(9);
    }
  } else if (kind === 'transfer') {
    from = 'inventory_transfers s';
    ref = "'نقل '||LEFT(s.id::text,8)";
    if (role === 'operator') scope = '$1::text IS NULL';
    if (role === 'merchant') {
      scope = 's.merchant_id=$1';
      value = account!.merchantId;
    }
    if (role === 'courier') {
      scope = 's.courier_id=$1';
      value = account!.courierId;
    }
  } else {
    from =
      'partner_payments s JOIN execution_earnings e ON e.shipment_id=s.shipment_id JOIN shipments sh ON sh.id=s.shipment_id';
    ref = "sh.reference||' · أجر '||LEFT(s.id::text,8)";
    if (role === 'operator') scope = '$1::text IS NULL';
    if (role === 'company') {
      scope = 'e.company_id=$1';
      value = account!.companyId ?? null;
    }
    if (role === 'courier') {
      scope = 'e.courier_id=$1 AND e.company_id IS NULL';
      value = account!.courierId;
    }
  }
  return {
    sql: `SELECT s.id,${ref} reference FROM ${from} WHERE (${scope}) AND ($2::uuid IS NULL OR s.id=$2) AND ($3::text IS NULL OR ${ref} ILIKE $3) ORDER BY s.created_at DESC,s.id LIMIT 25`,
    value,
  };
}
async function participants(tx: Transaction, kind: DisputeSubject, id: string) {
  const rows: { audience: string; name: string; role: string }[] = [];
  const add = (id: string | null, name: string, role: string) => {
    if (id) rows.push({ audience: 'account:' + id, name, role });
  };
  if (kind === 'partner_payment') {
    const e = (
      await tx.query<{ company_id: string | null; courier_id: string; beneficiary_name: string }>(
        `SELECT e.* FROM partner_payments p JOIN execution_earnings e ON e.shipment_id=p.shipment_id WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
    add(
      e.company_id ? 'office-' + e.company_id : e.courier_id,
      e.beneficiary_name,
      e.company_id ? 'company' : 'courier',
    );
  } else {
    const p = (
      await tx.query<{
        merchant_id: string;
        courier_id: string | null;
        pickup_site_id?: string | null;
        delivery_courier?: string | null;
      }>(
        kind === 'shipment'
          ? `SELECT s.merchant_id,s.courier_id,s.pickup_site_id,d.courier_id delivery_courier FROM shipments s LEFT JOIN delivery_service_subjects d ON d.shipment_id=s.id WHERE s.id=$1`
          : 'SELECT merchant_id,courier_id FROM inventory_transfers WHERE id=$1',
        [id],
      )
    ).rows[0];
    const m = (
      await tx.query<{ name: string }>('SELECT name FROM merchants WHERE id=$1', [p.merchant_id])
    ).rows[0];
    add(p.merchant_id, m.name, 'merchant');
    for (const courier of new Set([p.courier_id, p.delivery_courier].filter(Boolean))) {
      const c = (
        await tx.query<{ name: string }>('SELECT name FROM couriers WHERE id=$1', [courier])
      ).rows[0];
      if (c) add(courier!, c.name, 'courier');
    }
    if (p.pickup_site_id) {
      const site = (
        await tx.query<{ name: string }>('SELECT name FROM sites WHERE id=$1', [p.pickup_site_id])
      ).rows[0];
      add(p.pickup_site_id, site.name, 'pickup');
    }
    if (kind === 'shipment')
      for (const c of (
        await tx.query<{ owner_hash: string }>(
          'SELECT DISTINCT owner_hash FROM storefront_checkouts WHERE shipment_id=$1',
          [id],
        )
      ).rows)
        rows.push({ audience: 'customer:' + c.owner_hash, name: 'العميل', role: 'customer' });
  }
  return rows;
}
export async function disputeNotifications(
  tx: Transaction,
  audience: string,
  operator: boolean,
  now: number,
): Promise<UserNotification[]> {
  const rows = (
    await tx.query<DisputeCase & { publicVersion: number }>(
      `SELECT ${columns},d.public_version AS "publicVersion" FROM disputes d WHERE ${disputeScope} ORDER BY d.updated_at DESC,d.id LIMIT 100`,
      [audience, new Date(now).toISOString(), operator],
    )
  ).rows;
  return rows.map((d) => ({
    id: `dispute:${d.id}:${d.publicVersion}:${d.overdue ? 'late' : 'current'}`,
    kind: 'dispute',
    targetId: d.id,
    reference: d.reference,
    title: d.overdue
      ? 'متابعة تجاوزت المهلة'
      : d.waitingForMe
        ? 'حالة تحتاج ردّك'
        : d.status === 'resolved'
          ? 'قرار موثّق في المتابعة'
          : d.status === 'closed'
            ? 'أغلقت المتابعة'
            : 'تحديث في حالة المتابعة',
    page: 'disputes',
    actionRequired:
      d.overdue ||
      d.waitingForMe ||
      (operator && !['resolved', 'closed'].includes(d.status)) ||
      (d.createdByMe && d.status === 'resolved'),
    createdAt: new Date(d.updatedAt).toISOString(),
    read: false,
  }));
}
export function registerDisputes(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  identity: (req: FastifyRequest) => Account | string,
  clock: () => number,
  operators: () => Promise<Account[]> = async () => demoAccounts,
  prefix = '/api/disputes',
) {
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  const actor = (req: FastifyRequest) => {
    const a = audienceOf(identity(req));
    assert(
      req.headers['x-dispute-actor'] === undefined ||
        req.headers['x-dispute-actor'] === (a.account?.id ?? 'customer'),
      403,
      'ACCOUNT_CHANGED',
      'تغير حساب الجلسة؛ عد إلى الحساب الأصلي قبل إرسال الإجراء',
    );
    return a;
  };
  async function staff() {
    return (await operators()).filter((a) => a.role === 'operator');
  }
  async function get(tx: Transaction, a: Actor, id: string) {
    const d = (
      await tx.query<DisputeCase>(
        `SELECT ${columns} FROM disputes d WHERE ${disputeScope} AND d.id=$4`,
        [a.audience, new Date(clock()).toISOString(), a.role === 'operator', id],
      )
    ).rows[0];
    assert(d, 404, 'NOT_FOUND', 'الحالة غير متاحة لحسابك');
    return d;
  }
  async function event(
    tx: Transaction,
    a: Actor,
    id: string,
    action: string,
    message: string,
    body: unknown,
    visibility = 'shared',
  ) {
    await tx.query(
      'INSERT INTO dispute_events(id,dispute_id,actor_name,actor_audience,action,visibility,text,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        id,
        a.name,
        a.audience,
        action,
        visibility,
        message,
        JSON.stringify(body),
        new Date(clock()).toISOString(),
      ],
    );
  }
  app.get(prefix + '/subjects', async (req) => {
    const a = actor(req),
      b = z
        .object({ kind: subjectKind, search: z.string().trim().max(80).default('') })
        .strict()
        .parse(req.query),
      q = subjectQuery(a, b.kind);
    return write(async (tx) => ({
      rows: (
        await tx.query(q.sql, [
          q.value,
          null,
          b.search ? '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%' : null,
        ])
      ).rows,
      limit: 25,
    }));
  });
  app.get(prefix, async (req) => {
    const a = actor(req),
      b = z
        .object({
          state: z.enum(['active', 'resolved', 'closed', 'all']).default('active'),
          search: z.string().trim().max(80).default(''),
          page: z.coerce.number().int().min(0).max(10000).default(0),
          attention: z.enum(['all', 'overdue', 'escalated']).default('all'),
        })
        .strict()
        .parse(req.query);
    return write(async (tx) => {
      const scope = [a.audience, new Date(clock()).toISOString(), a.role === 'operator'];
      const filter = `${disputeScope} AND ($4::text='all' OR ($4='active' AND d.status NOT IN ('resolved','closed')) OR d.status=$4) AND ($5::text IS NULL OR d.reference ILIKE $5 OR d.subject_reference ILIKE $5) AND ($6::text='all' OR ($6='overdue' AND d.due_at<$2::timestamptz AND d.status NOT IN ('resolved','closed')) OR ($6='escalated' AND d.escalated_at IS NOT NULL AND d.status NOT IN ('resolved','closed')))`;
      const params = [
        ...scope,
        b.state,
        b.search ? '%' + b.search.replace(/[\\%_]/g, '\\$&') + '%' : null,
        b.attention,
      ];
      const rows = (
        await tx.query(
          `SELECT ${columns} FROM disputes d WHERE ${filter} ORDER BY (d.escalated_at IS NOT NULL AND d.status NOT IN ('resolved','closed')) DESC,(d.due_at<$2::timestamptz AND d.status NOT IN ('resolved','closed')) DESC,d.updated_at DESC,d.id LIMIT 25 OFFSET $7`,
          [...params, b.page * 25],
        )
      ).rows;
      const total = (
        await tx.query<{ count: number }>(
          `SELECT COUNT(*)::integer count FROM disputes d WHERE ${filter}`,
          params,
        )
      ).rows[0].count;
      const stats = (
        await tx.query(
          `SELECT COUNT(*) FILTER(WHERE d.status NOT IN ('resolved','closed'))::integer active,COUNT(*) FILTER(WHERE d.due_at<$2::timestamptz AND d.status NOT IN ('resolved','closed'))::integer overdue,COUNT(*) FILTER(WHERE d.escalated_at IS NOT NULL AND d.status NOT IN ('resolved','closed'))::integer escalated FROM disputes d WHERE ${disputeScope}`,
          scope,
        )
      ).rows[0];
      return {
        rows,
        total,
        page: b.page,
        pageSize: 25,
        stats,
        operators: a.role === 'operator' ? await staff() : [],
      };
    });
  });
  app.get(prefix + '/:id', async (req) => {
    const a = actor(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    return write(async (tx) => {
      const d = await get(tx, a, id);
      return {
        case: d,
        canManage: a.role === 'operator',
        canClose: d.createdByMe,
        participants: (
          await tx.query(
            'SELECT id,name,role FROM dispute_participants WHERE dispute_id=$1 ORDER BY role,name,id',
            [id],
          )
        ).rows,
        events: (
          await tx.query(
            `SELECT id,action,actor_name AS "actorName",visibility,text,created_at AS "createdAt" FROM dispute_events WHERE dispute_id=$1 AND ($2::boolean OR visibility='shared') ORDER BY sequence DESC LIMIT 100`,
            [id, a.role === 'operator'],
          )
        ).rows.reverse(),
        eventLimit: 100,
      };
    });
  });
  app.post(prefix, async (req) => {
    const a = actor(req),
      b = z
        .object({
          subjectKind,
          subjectId: z.string().uuid(),
          topic: z.enum(
            Object.keys(disputeTopics) as [
              keyof typeof disputeTopics,
              ...(keyof typeof disputeTopics)[],
            ],
          ),
          summary: text,
        })
        .strict()
        .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.audience}:dispute:create`, key(req), b, async () => {
        const q = subjectQuery(a, b.subjectKind),
          subject = (
            await tx.query<{ id: string; reference: string }>(q.sql, [q.value, b.subjectId, null])
          ).rows[0];
        assert(subject, 404, 'NOT_FOUND', 'السجل غير متاح لفتح متابعة');
        assert(
          !(
            await tx.query(
              "SELECT id FROM disputes WHERE subject_kind=$1 AND subject_id=$2 AND topic=$3 AND creator_audience=$4 AND status<>'closed'",
              [b.subjectKind, b.subjectId, b.topic, a.audience],
            )
          ).rows.length,
          409,
          'CASE_EXISTS',
          'توجد متابعة لهذا الموضوع؛ افتحها من قائمتك بدل تكرارها',
        );
        const owner = (await staff())[0];
        assert(owner, 409, 'NO_CASE_OWNER', 'لا يوجد مسؤول عمليات متاح لاستلام الحالة');
        const id = randomUUID(),
          now = clock(),
          reference = 'CASE-' + randomBytes(5).toString('hex').toUpperCase();
        await tx.query(
          `INSERT INTO disputes(id,reference,subject_kind,subject_id,shipment_id,transfer_id,partner_payment_id,subject_reference,creator_audience,creator_role,topic,summary,assignee_id,assignee_name,due_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
          [
            id,
            reference,
            b.subjectKind,
            b.subjectId,
            b.subjectKind === 'shipment' ? b.subjectId : null,
            b.subjectKind === 'transfer' ? b.subjectId : null,
            b.subjectKind === 'partner_payment' ? b.subjectId : null,
            subject.reference,
            a.audience,
            a.role,
            b.topic,
            b.summary,
            owner.id,
            owner.name,
            new Date(now + 24 * 3600000).toISOString(),
            new Date(now).toISOString(),
          ],
        );
        const people = [
          ...(await participants(tx, b.subjectKind, b.subjectId)),
          a,
          { audience: 'account:' + owner.id, name: owner.name, role: 'operator' },
        ];
        const seen = new Set<string>();
        for (const p of people)
          if (!seen.has(p.audience)) {
            seen.add(p.audience);
            await tx.query(
              'INSERT INTO dispute_participants(id,dispute_id,audience,name,role) VALUES($1,$2,$3,$4,$5)',
              [randomUUID(), id, p.audience, p.name, p.role],
            );
          }
        await event(tx, a, id, 'created', b.summary, b);
        return { id, reference };
      }),
    );
  });
  app.post(prefix + '/:id/actions', async (req) => {
    const a = actor(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const b = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.enum(['reply', 'internal_note', 'escalate', 'reopen', 'close']),
            expectedVersion: z.number().int().positive(),
            text,
          })
          .strict(),
        z
          .object({
            action: z.literal('assign'),
            expectedVersion: z.number().int().positive(),
            assigneeId: z.string().min(1).max(40),
            dueHours: z.union([z.literal(4), z.literal(24), z.literal(72)]),
            text,
          })
          .strict(),
        z
          .object({
            action: z.literal('request_reply'),
            expectedVersion: z.number().int().positive(),
            participantId: z.string().uuid(),
            text,
          })
          .strict(),
        z
          .object({
            action: z.literal('resolve'),
            expectedVersion: z.number().int().positive(),
            decision: z.enum(
              Object.keys(disputeDecisions) as [
                keyof typeof disputeDecisions,
                ...(keyof typeof disputeDecisions)[],
              ],
            ),
            text,
          })
          .strict(),
      ])
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.audience}:dispute:${id}`, key(req), b, async () => {
        const d = await get(tx, a, id),
          ops = a.role === 'operator',
          now = clock();
        assert(
          d.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت الحالة؛ حدّثها قبل المتابعة',
        );
        assert(
          d.status !== 'closed',
          409,
          'CASE_CLOSED',
          'المتابعة مغلقة؛ يمكن فتح متابعة جديدة مرتبطة بالسجل',
        );
        let status: DisputeCase['status'] = d.status;
        let assigneeId = d.assigneeId,
          assigneeName = d.assigneeName,
          dueAt = d.dueAt,
          waiting: string | null = null,
          decision: string | null = d.decision,
          decisionText = d.decisionText,
          escalatedAt = d.escalatedAt;
        const manage = ['assign', 'request_reply', 'resolve', 'internal_note'].includes(b.action);
        assert(!manage || ops, 403, 'FORBIDDEN', 'هذا الإجراء لإدارة العمليات فقط');
        if (b.action === 'internal_note') {
          await event(tx, a, id, b.action, b.text, b, 'internal');
          await tx.query('UPDATE disputes SET version=version+1 WHERE id=$1', [id]);
          return { id, version: d.version + 1 };
        }
        if (b.action === 'reply') {
          assert(
            !['resolved', 'closed'].includes(status),
            409,
            'INVALID_STATE',
            'استخدم الاعتراض لإعادة فتح القرار',
          );
          if (status === 'waiting_reply' && !d.waitingForMe) {
            waiting = d.waitingForId;
          } else status = 'under_review';
        } else if (b.action === 'assign') {
          assert(status !== 'resolved', 409, 'INVALID_STATE', 'أعد فتح القرار قبل إعادة الإسناد');
          const next = (await staff()).find((s) => s.id === b.assigneeId);
          assert(next, 422, 'INVALID_ASSIGNEE', 'المسؤول ليس ضمن مستخدمي العمليات المتاحين');
          assigneeId = next.id;
          assigneeName = next.name;
          dueAt = new Date(now + b.dueHours! * 3600000).toISOString();
          status = 'under_review';
        } else if (b.action === 'request_reply') {
          assert(
            status !== 'resolved' && d.assigneeId === a.account?.id,
            409,
            'INVALID_STATE',
            'طلب الرد لمسؤول الحالة الحالية',
          );
          const p = (
            await tx.query<{ audience: string; role: string }>(
              'SELECT audience,role FROM dispute_participants WHERE id=$1 AND dispute_id=$2',
              [b.participantId, id],
            )
          ).rows[0];
          assert(
            p && p.role !== 'operator',
            422,
            'INVALID_PARTICIPANT',
            'اختر طرفًا مشاركًا في الحالة',
          );
          waiting = b.participantId!;
          status = 'waiting_reply';
        } else if (b.action === 'resolve') {
          assert(
            status !== 'resolved' && d.assigneeId === a.account?.id,
            409,
            'INVALID_STATE',
            'توثيق القرار لمسؤول الحالة الحالية',
          );
          status = 'resolved';
          decision = b.decision!;
          decisionText = b.text;
        } else if (b.action === 'close') {
          assert(
            status === 'resolved' && d.createdByMe,
            403,
            'FORBIDDEN',
            'إغلاق المتابعة بعد القرار لصاحبها فقط؛ يمكن الاعتراض بدل الإغلاق',
          );
          status = 'closed';
        } else if (b.action === 'reopen') {
          assert(status === 'resolved', 409, 'INVALID_STATE', 'الاعتراض متاح بعد قرار موثق');
          status = 'under_review';
          decision = null;
          decisionText = null;
          dueAt = new Date(now + 24 * 3600000).toISOString();
          escalatedAt = null;
        } else if (b.action === 'escalate') {
          assert(
            status !== 'resolved' && !escalatedAt && (ops || d.overdue),
            409,
            'ESCALATION_UNAVAILABLE',
            'رفع الأولوية متاح مرة في دورة المتابعة، وللطرف بعد تجاوز المهلة',
          );
          escalatedAt = new Date(now).toISOString();
          status = 'under_review';
        }
        await tx.query(
          'UPDATE disputes SET status=$2,version=version+1,public_version=public_version+1,assignee_id=$3,assignee_name=$4,due_at=$5,waiting_for=$6,decision=$7,decision_text=$8,escalated_at=$9,updated_at=$10 WHERE id=$1',
          [
            id,
            status,
            assigneeId,
            assigneeName,
            dueAt,
            waiting,
            decision,
            decisionText,
            escalatedAt,
            new Date(now).toISOString(),
          ],
        );
        await event(tx, a, id, b.action, b.text, b);
        return { id, status, version: d.version + 1 };
      }),
    );
  });
}
