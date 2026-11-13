import { z } from 'zod';

// Mirrors tool-samadhan apps/backend/NOTIFICATION_EVENTS.md (contract version 1).
export const EVENT_TYPES = [
  'ticket.created',
  'ticket.reassigned',
  'ticket.reply',
  'ticket.internal_note',
  'ticket.status_changed',
  'ticket.rca_added',
  'ticket.outage',
  'ticket.rated',
  'ticket.auto_closed',
  'ticket.sla_breach',
  'ticket.automated_update',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const SUPPORTED_VERSIONS = [1];

const id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);

export const eventSchema = z.object({
  eventId: z.uuid(),
  version: z.number().int(),
  eventType: z.enum(EVENT_TYPES),
  ticketId: id,
  actorUserId: id.nullable(),
  occurredAt: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export type NotificationEvent = z.infer<typeof eventSchema>;
