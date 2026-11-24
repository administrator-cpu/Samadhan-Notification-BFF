import { UnrecoverableError } from 'bullmq';
import { eventSchema, SUPPORTED_VERSIONS, type NotificationEvent } from '../contract.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import {
  getActiveAdminIds,
  getEmployeeUsers,
  getLatestAutomatedUpdate,
  getTicketContext,
  getTicketEventMessage,
  getUsers,
} from '../repo/backend.js';
import {
  getDisabledEvents,
  getUnreadCounts,
  incrementUnread,
  isEventProcessed,
  markEventProcessed,
  recordRecipients,
} from '../repo/state.js';
import { getTokensForDelivery } from '../repo/tokens.js';
import { deliver, type Outgoing, type SendSummary } from '../push/sender.js';
import { buildMessage } from './messages.js';
import { resolveRecipients } from './recipients.js';

export interface ProcessResult {
  status: 'processed' | 'duplicate' | 'ticket_missing';
  recipients: number;
  delivery?: SendSummary;
}

export function parseEvent(data: unknown): NotificationEvent {
  const parsed = eventSchema.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError(`Invalid event payload: ${parsed.error.message}`);
  if (!SUPPORTED_VERSIONS.includes(parsed.data.version)) {
    throw new UnrecoverableError(`Unsupported contract version ${parsed.data.version}`);
  }
  return parsed.data;
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export async function processEvent(raw: unknown): Promise<ProcessResult> {
  const event = parseEvent(raw);
  const log = { eventId: event.eventId, eventType: event.eventType, ticketId: event.ticketId };

  if (await isEventProcessed(pool, event.eventId)) {
    logger.info('event already processed', log);
    return { status: 'duplicate', recipients: 0 };
  }

  const ticket = await getTicketContext(pool, event.ticketId);
  if (!ticket) {
    logger.warn('ticket not found; skipping', log);
    await markEventProcessed(pool, event.eventId, event.eventType, event.ticketId, 0);
    return { status: 'ticket_missing', recipients: 0 };
  }

  const newEmployeeId = str(event.meta.newEmployeeId) ?? str(event.meta.assignedEmployeeId);
  const previousEmployeeId = str(event.meta.previousEmployeeId);
  const employees = await getEmployeeUsers(pool, [newEmployeeId, previousEmployeeId].filter((x): x is string => !!x));
  const newAgent = newEmployeeId ? employees.get(newEmployeeId) ?? null : null;
  const previousAgent = previousEmployeeId ? employees.get(previousEmployeeId) ?? null : null;

  const needsAdmins = ['ticket.created', 'ticket.reply', 'ticket.rated', 'ticket.sla_breach'].includes(event.eventType);
  const adminUserIds = needsAdmins ? await getActiveAdminIds(pool) : [];

  let recipients = resolveRecipients({
    event,
    ticket,
    newAgentUserId: newAgent?.userId ?? null,
    previousAgentUserId: previousAgent?.userId ?? null,
    adminUserIds,
  });

  const users = await getUsers(pool, [...recipients.map((r) => r.userId), ...(event.actorUserId ? [event.actorUserId] : [])]);
  const disabled = await getDisabledEvents(pool, recipients.map((r) => r.userId));
  recipients = recipients.filter((r) => {
    const u = users.get(r.userId);
    return u?.isActive && !disabled.get(r.userId)?.has(event.eventType);
  });

  if (recipients.length === 0) {
    await markEventProcessed(pool, event.eventId, event.eventType, event.ticketId, 0);
    logger.info('no recipients', log);
    return { status: 'processed', recipients: 0 };
  }

  // Unread counts drive the badge. recordRecipients makes this safe across retries.
  const firstTime = await recordRecipients(pool, event.eventId, recipients.map((r) => r.userId));
  await incrementUnread(pool, [...firstTime], event.ticketId);
  const unread = await getUnreadCounts(pool, recipients.map((r) => r.userId));

  let snippet: string | null = null;
  const ticketEventId = str(event.meta.ticketEventId);
  if (ticketEventId) snippet = await getTicketEventMessage(pool, event.ticketId, ticketEventId);
  else if (event.eventType === 'ticket.automated_update') snippet = await getLatestAutomatedUpdate(pool, event.ticketId);
  else if (event.eventType === 'ticket.rated') snippet = ticket.ratingFeedback;

  const actorName = event.actorUserId ? users.get(event.actorUserId)?.name ?? null : null;
  const tokens = await getTokensForDelivery(pool, recipients.map((r) => r.userId));

  const outgoing: Outgoing[] = [];
  for (const r of recipients) {
    const user = users.get(r.userId)!;
    const msg = buildMessage({
      eventType: event.eventType,
      audience: r.audience,
      ticketNo: ticket.ticketNo,
      category: ticket.category,
      customerName: ticket.customerName,
      actorName,
      newAgentName: newAgent?.name ?? ticket.agentName,
      snippet,
      meta: event.meta,
    });
    for (const token of tokens.filter((t) => t.userId === r.userId)) {
      outgoing.push({
        userId: r.userId,
        token,
        message: {
          to: token.token,
          title: msg.title,
          body: msg.body,
          channelId: msg.channelId,
          priority: 'high',
          sound: 'default',
          badge: unread.get(r.userId) ?? 0,
          ttl: 24 * 60 * 60,
          tag: `ticket-${ticket.id}`,
          threadId: `ticket-${ticket.id}`,
          data: {
            ticketId: ticket.id,
            ticketNo: ticket.ticketNo,
            role: user.role,
            eventType: event.eventType,
            eventId: event.eventId,
          },
        },
      });
    }
  }

  const delivery = await deliver(event.eventId, event.eventType, event.ticketId, outgoing);
  await markEventProcessed(pool, event.eventId, event.eventType, event.ticketId, recipients.length);
  logger.info('event processed', { ...log, recipients: recipients.length, ...delivery });
  return { status: 'processed', recipients: recipients.length, delivery };
}
