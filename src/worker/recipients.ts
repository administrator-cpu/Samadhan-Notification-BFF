import type { NotificationEvent } from '../contract.js';
import type { TicketContext } from '../repo/backend.js';

export type Audience = 'customer' | 'agent' | 'new_agent' | 'previous_agent' | 'admin';

export interface Recipient {
  userId: string;
  audience: Audience;
}

export interface RecipientInput {
  event: NotificationEvent;
  ticket: TicketContext;
  /** Resolved from meta.assignedEmployeeId (created) or meta.newEmployeeId (reassigned). */
  newAgentUserId: string | null;
  /** Resolved from meta.previousEmployeeId (reassigned). */
  previousAgentUserId: string | null;
  adminUserIds: string[];
}

/**
 * Who should hear about an event. Pure: no I/O.
 * The actor is removed and duplicates collapse to the first (most specific) audience.
 */
export function resolveRecipients(input: RecipientInput): Recipient[] {
  const { event, ticket, newAgentUserId, previousAgentUserId, adminUserIds } = input;
  const out: Recipient[] = [];
  const add = (userId: string | null | undefined, audience: Audience) => {
    if (userId) out.push({ userId, audience });
  };
  const admins = () => adminUserIds.forEach((id) => add(id, 'admin'));
  const agent = ticket.agentUserId;

  switch (event.eventType) {
    case 'ticket.created': {
      add(ticket.customerUserId, 'customer');
      const assigned = newAgentUserId ?? agent;
      if (assigned) add(assigned, 'new_agent');
      else admins(); // nobody picked it up: tell the admins
      break;
    }
    case 'ticket.reassigned':
      add(newAgentUserId ?? agent, 'new_agent');
      if (previousAgentUserId && previousAgentUserId !== (newAgentUserId ?? agent)) {
        add(previousAgentUserId, 'previous_agent');
      }
      add(ticket.customerUserId, 'customer');
      break;
    case 'ticket.reply': {
      const fromCustomer = event.meta.replyType === 'USER_REPLY' || event.actorUserId === ticket.customerUserId;
      if (fromCustomer) {
        if (agent) add(agent, 'agent');
        else admins();
      } else {
        add(ticket.customerUserId, 'customer');
        add(agent, 'agent'); // e.g. an admin replied on the agent's ticket
      }
      break;
    }
    case 'ticket.internal_note':
      add(agent, 'agent');
      break;
    case 'ticket.status_changed':
      add(ticket.customerUserId, 'customer');
      add(agent, 'agent');
      break;
    case 'ticket.rca_added':
    case 'ticket.outage':
    case 'ticket.auto_closed':
    case 'ticket.automated_update':
      add(ticket.customerUserId, 'customer');
      break;
    case 'ticket.rated':
      add(agent, 'agent');
      admins();
      break;
    case 'ticket.sla_breach':
      add(agent, 'agent');
      admins();
      break;
  }

  const seen = new Set<string>();
  return out.filter((r) => {
    if (r.userId === event.actorUserId) return false;
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });
}
