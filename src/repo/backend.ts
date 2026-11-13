// Read-only queries against backend-owned tables in the "public" schema.
import type { Queryable } from '../db.js';

export interface TicketContext {
  id: string;
  ticketNo: string;
  status: string;
  category: string | null;
  customerUserId: string;
  customerName: string;
  agentUserId: string | null;
  agentName: string | null;
  ratingFeedback: string | null;
  problemSide: string | null;
  telcoSrNumber: string | null;
}

export interface UserRow {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

export async function getTicketContext(db: Queryable, ticketId: string): Promise<TicketContext | null> {
  const { rows } = await db.query(
    `SELECT t.id::text, t.ticket_no, t.status::text, ic.name AS category,
            c.user_id::text AS customer_user_id, cu.name AS customer_name,
            e.user_id::text AS agent_user_id, au.name AS agent_name,
            t.rating_feedback, t.problem_side, t.telco_sr_number
       FROM public.tickets t
       JOIN public.customers c ON c.id = t.customer_id
       JOIN public.users cu ON cu.id = c.user_id
       LEFT JOIN public.employees e ON e.id = t.current_assigned_employee_id
       LEFT JOIN public.users au ON au.id = e.user_id
       LEFT JOIN public.issue_categories ic ON ic.id = t.primary_issue_category_id
      WHERE t.id = $1`,
    [ticketId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    ticketNo: r.ticket_no,
    status: r.status,
    category: r.category,
    customerUserId: r.customer_user_id,
    customerName: r.customer_name,
    agentUserId: r.agent_user_id,
    agentName: r.agent_name,
    ratingFeedback: r.rating_feedback,
    problemSide: r.problem_side,
    telcoSrNumber: r.telco_sr_number,
  };
}

/** employees.id → { userId, name } */
export async function getEmployeeUsers(db: Queryable, employeeIds: string[]): Promise<Map<string, { userId: string; name: string }>> {
  const out = new Map<string, { userId: string; name: string }>();
  if (employeeIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT e.id::text AS employee_id, e.user_id::text AS user_id, u.name
       FROM public.employees e JOIN public.users u ON u.id = e.user_id
      WHERE e.id = ANY($1::bigint[])`,
    [employeeIds],
  );
  for (const r of rows) out.set(r.employee_id, { userId: r.user_id, name: r.name });
  return out;
}

export async function getUsers(db: Queryable, userIds: string[]): Promise<Map<string, UserRow>> {
  const out = new Map<string, UserRow>();
  if (userIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT id::text, name, role::text, is_active FROM public.users WHERE id = ANY($1::bigint[])`,
    [userIds],
  );
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name, role: r.role, isActive: r.is_active });
  return out;
}

export async function getActiveAdminIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id::text FROM public.users WHERE role = 'ADMIN' AND is_active = true`,
  );
  return rows.map((r) => r.id);
}

export async function getTicketEventMessage(db: Queryable, ticketId: string, ticketEventId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT message FROM public.ticket_events WHERE id = $1 AND ticket_id = $2`,
    [ticketEventId, ticketId],
  );
  return rows[0]?.message ?? null;
}

export async function getLatestAutomatedUpdate(db: Queryable, ticketId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT message FROM public.ticket_events
      WHERE ticket_id = $1 AND event_type = 'AUTOMATED_UPDATE'
      ORDER BY created_at DESC LIMIT 1`,
    [ticketId],
  );
  return rows[0]?.message ?? null;
}

/** True when the access token's session is live and the user is active. */
export async function isSessionValid(db: Queryable, userId: string, jti: string | undefined): Promise<boolean> {
  if (jti) {
    const { rows } = await db.query(
      `SELECT 1 FROM public.sessions s JOIN public.users u ON u.id = s.user_id
        WHERE s.jti = $1 AND s.user_id = $2 AND s.revoked = false AND s.expires_at > now() AND u.is_active = true`,
      [jti, userId],
    );
    return rows.length > 0;
  }
  const { rows } = await db.query(`SELECT 1 FROM public.users WHERE id = $1 AND is_active = true`, [userId]);
  return rows.length > 0;
}
