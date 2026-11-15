import { z } from 'zod';

// Mirrors tool-samadhan apps/backend/src/lib/push.ts (call contract version 1).
export const CALL_PUSH_TYPES = ['call_invite', 'call_cancel', 'call_missed'] as const;
export type CallPushType = (typeof CALL_PUSH_TYPES)[number];

export const CANCEL_REASONS = ['caller_cancelled', 'answered_elsewhere', 'declined_elsewhere'] as const;

export const CALL_SUPPORTED_VERSIONS = [1];

const optStr = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));

export const callJobSchema = z.object({
  version: z.number().int(),
  jobId: z.uuid(),
  type: z.enum(CALL_PUSH_TYPES),
  toEmail: z.string().min(3).max(320).transform((e) => e.trim().toLowerCase()),
  toUserId: optStr,
  callId: z.string().min(1).max(128),
  ticketId: optStr,
  ticketNumber: optStr,
  callerName: optStr,
  fromEmail: optStr,
  declineToken: optStr,
  reason: z.enum(CANCEL_REASONS).nullish().transform((v) => v ?? null),
  /** Cancel only: the callee device that answered/declined does not need its own cancel. */
  excludeDeviceId: optStr,
  ttlSec: z.number().int().positive().max(3600),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type CallJob = z.infer<typeof callJobSchema>;

/** Flat string map shared by APNs (top-level keys) and FCM (data). The app reads these keys natively. */
export function callPayload(job: CallJob): Record<string, string> {
  const out: Record<string, string> = {
    type: job.type,
    callId: job.callId,
    expiresAt: String(Date.parse(job.expiresAt) || Date.now() + job.ttlSec * 1000),
  };
  const put = (k: string, v: string | null) => {
    if (v !== null) out[k] = v;
  };
  put('ticketId', job.ticketId);
  put('ticketNumber', job.ticketNumber);
  put('callerName', job.callerName);
  put('fromEmail', job.fromEmail);
  put('declineToken', job.declineToken);
  put('reason', job.reason);
  return out;
}
