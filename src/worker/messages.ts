import type { EventType } from '../contract.js';
import type { Audience } from './recipients.js';

export const CHANNELS = {
  TICKET_UPDATES: 'ticket_updates',
  ASSIGNMENTS: 'assignments',
  MISSED_CALL: 'missed_call',
} as const;

export interface MessageInput {
  eventType: EventType;
  audience: Audience;
  ticketNo: string;
  category: string | null;
  customerName: string;
  actorName: string | null;
  newAgentName: string | null;
  snippet: string | null;
  meta: Record<string, unknown>;
}

export interface Message {
  title: string;
  body: string;
  channelId: string;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'open',
  IN_PROGRESS: 'in progress',
  ESCALATED: 'escalated',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

export function truncate(text: string | null | undefined, max = 160): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** English copy for every event × audience. Pure: no I/O. */
export function buildMessage(m: MessageInput): Message {
  const no = m.ticketNo;
  const about = m.category ? ` about ${m.category}` : '';
  const updates = CHANNELS.TICKET_UPDATES;
  const assignments = CHANNELS.ASSIGNMENTS;
  const actor = m.actorName ?? 'Someone';
  const snippet = truncate(m.snippet);

  switch (m.eventType) {
    case 'ticket.created':
      if (m.audience === 'customer') {
        return { title: `Ticket ${no} created`, body: `We've received your ticket${about}. We'll keep you updated here.`, channelId: updates };
      }
      if (m.audience === 'new_agent') {
        return { title: `New ticket assigned: ${no}`, body: `${m.customerName}${m.category ? ` · ${m.category}` : ''}`, channelId: assignments };
      }
      return { title: `New unassigned ticket ${no}`, body: `${m.customerName}${m.category ? ` · ${m.category}` : ''}`, channelId: assignments };

    case 'ticket.reassigned':
      if (m.audience === 'new_agent') {
        return { title: `Ticket ${no} assigned to you`, body: `${m.customerName}${m.category ? ` · ${m.category}` : ''}`, channelId: assignments };
      }
      if (m.audience === 'previous_agent') {
        return { title: `Ticket ${no} reassigned`, body: m.newAgentName ? `It's now handled by ${m.newAgentName}.` : `It has been moved to another engineer.`, channelId: assignments };
      }
      return { title: `Update on ticket ${no}`, body: m.newAgentName ? `${m.newAgentName} is now handling your ticket.` : `An engineer has been assigned to your ticket.`, channelId: updates };

    case 'ticket.reply':
      return { title: `${actor} replied on ${no}`, body: snippet || 'Open the ticket to read the reply.', channelId: updates };

    case 'ticket.internal_note':
      return { title: `Internal note on ${no}`, body: snippet ? `${actor}: ${snippet}` : `${actor} added a note.`, channelId: updates };

    case 'ticket.status_changed': {
      const requested = String(m.meta.requestedStatus ?? m.meta.newStatus ?? '');
      const status = String(m.meta.newStatus ?? requested);
      if (requested === 'REOPENED') {
        return m.audience === 'customer'
          ? { title: `Ticket ${no} reopened`, body: `We're looking into it again.`, channelId: updates }
          : { title: `Ticket ${no} reopened`, body: `${m.customerName} reopened the ticket.`, channelId: assignments };
      }
      if (m.audience === 'customer') {
        if (status === 'RESOLVED') return { title: `Ticket ${no} resolved`, body: `Your issue has been resolved. You can reopen it within 24 hours if it's not fixed.`, channelId: updates };
        if (status === 'CLOSED') return { title: `Ticket ${no} closed`, body: `Thanks for your patience. You can rate the support you received.`, channelId: updates };
        if (status === 'ESCALATED') return { title: `Ticket ${no} escalated`, body: `Your ticket has been escalated for priority handling.`, channelId: updates };
        if (status === 'IN_PROGRESS') return { title: `Ticket ${no} in progress`, body: `We're working on your issue.`, channelId: updates };
      }
      return { title: `Ticket ${no} is ${STATUS_LABEL[status] ?? status.toLowerCase()}`, body: `Status changed by ${actor}.`, channelId: updates };
    }

    case 'ticket.rca_added':
      return { title: `Root cause shared for ${no}`, body: `Open the ticket to see what caused the issue.`, channelId: updates };

    case 'ticket.outage': {
      const side = m.meta.problemSide ? String(m.meta.problemSide) : null;
      const ref = m.meta.externalTicketNo ? ` (ref ${String(m.meta.externalTicketNo)})` : '';
      return { title: `Update on ticket ${no}`, body: side ? `Issue identified on the ${side} side${ref}.` : `Outage details were updated${ref}.`, channelId: updates };
    }

    case 'ticket.rated': {
      const rating = Number(m.meta.rating);
      const stars = Number.isFinite(rating) ? `${rating}★` : 'rated';
      return { title: `${no} rated ${stars}`, body: snippet || `${m.customerName} rated the support.`, channelId: updates };
    }

    case 'ticket.auto_closed':
      return { title: `Ticket ${no} closed`, body: `Your ticket was closed automatically after resolution. You can rate the support you received.`, channelId: updates };

    case 'ticket.sla_breach':
      return { title: `SLA breached on ${no}`, body: `Open for over 4 hours and escalated. ${m.customerName}${m.category ? ` · ${m.category}` : ''}`, channelId: assignments };

    case 'ticket.automated_update':
      return { title: `Update on ticket ${no}`, body: snippet || `We're working on your issue.`, channelId: updates };
  }
}
