import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET ??= 'unit';
const { resolveRecipients } = await import('../src/worker/recipients.js');
const { buildMessage, truncate } = await import('../src/worker/messages.js');

const ticket = {
  id: '100', ticketNo: 'TCK-1', status: 'IN_PROGRESS', category: 'Internet Down',
  customerUserId: '4', customerName: 'Acme', agentUserId: '2', agentName: 'Ravi',
  ratingFeedback: null, problemSide: null, telcoSrNumber: null,
};
const ev = (eventType: any, actorUserId: string | null, meta: Record<string, unknown> = {}) => ({
  eventId: '6f1c7a9e-8a8b-4b55-9a3e-1f8f4f0a1b2c', version: 1, eventType, ticketId: '100', actorUserId, occurredAt: '', meta,
});
const run = (e: any, extra: Partial<Parameters<typeof resolveRecipients>[0]> = {}) =>
  resolveRecipients({ event: e, ticket, newAgentUserId: null, previousAgentUserId: null, adminUserIds: ['1'], ...extra })
    .map((r) => `${r.userId}:${r.audience}`);

test('agent reply goes to customer only (actor dropped)', () => {
  assert.deepEqual(run(ev('ticket.reply', '2', { replyType: 'AGENT_REPLY' })), ['4:customer']);
});
test('admin reply goes to customer and assigned agent', () => {
  assert.deepEqual(run(ev('ticket.reply', '1', { replyType: 'ADMIN_REPLY' })), ['4:customer', '2:agent']);
});
test('customer reply goes to agent, or admins when unassigned', () => {
  assert.deepEqual(run(ev('ticket.reply', '4', { replyType: 'USER_REPLY' })), ['2:agent']);
  assert.deepEqual(resolveRecipients({ event: ev('ticket.reply', '4', { replyType: 'USER_REPLY' }) as any, ticket: { ...ticket, agentUserId: null }, newAgentUserId: null, previousAgentUserId: null, adminUserIds: ['1'] }).map((r) => r.userId), ['1']);
});
test('internal note never reaches the customer', () => {
  assert.deepEqual(run(ev('ticket.internal_note', '1')), ['2:agent']);
});
test('reassign: new agent, previous agent, customer; not the admin who did it', () => {
  assert.deepEqual(run(ev('ticket.reassigned', '1'), { newAgentUserId: '3', previousAgentUserId: '2' }), ['3:new_agent', '2:previous_agent', '4:customer']);
});
test('reassign to the same agent does not notify them twice', () => {
  assert.deepEqual(run(ev('ticket.reassigned', '1'), { newAgentUserId: '2', previousAgentUserId: '2' }), ['2:new_agent', '4:customer']);
});
test('created: customer confirmation (not if they created it) + assigned agent', () => {
  assert.deepEqual(run(ev('ticket.created', '4'), { newAgentUserId: '2' }), ['2:new_agent']);
  assert.deepEqual(run(ev('ticket.created', '1'), { newAgentUserId: '2' }), ['4:customer', '2:new_agent']);
});
test('sla breach goes to agent and admins, never the customer', () => {
  assert.deepEqual(run(ev('ticket.sla_breach', null)), ['2:agent', '1:admin']);
});

test('messages pick the right channel and copy', () => {
  const base = { ticketNo: 'TCK-1', category: 'Internet Down', customerName: 'Acme', actorName: 'Ravi', newAgentName: 'Meera', snippet: null, meta: {} };
  assert.equal(buildMessage({ ...base, eventType: 'ticket.reassigned', audience: 'new_agent' }).channelId, 'assignments');
  assert.equal(buildMessage({ ...base, eventType: 'ticket.reply', audience: 'customer', snippet: 'Hello there' }).body, 'Hello there');
  assert.equal(buildMessage({ ...base, eventType: 'ticket.status_changed', audience: 'customer', meta: { requestedStatus: 'RESOLVED', newStatus: 'RESOLVED' } }).title, 'Ticket TCK-1 resolved');
  assert.equal(buildMessage({ ...base, eventType: 'ticket.status_changed', audience: 'agent', meta: { requestedStatus: 'REOPENED', newStatus: 'IN_PROGRESS' } }).title, 'Ticket TCK-1 reopened');
  assert.equal(truncate('a'.repeat(300)).length, 160);
});
