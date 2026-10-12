// conversations.ts — a tenant's chats, for staff (plan/conversations.md, D-115).
//
// Every turn is already saved (saveMessages in answer.ts, refusals and
// failures included), so nothing new is recorded for this and nothing here
// writes (plan Rule 1). Two reads:
//
//   listConversations()  one page of the list, from conversation_list() in
//     SQL: the counts per conversation are aggregates, which PostgREST does
//     not do, and in JS they would read every message of the window.
//   getTranscript()      one conversation's messages, oldest first, each
//     named for what it is (a question, an answer, a refusal, a failure).
//
// Both run on a STAFF context: the routes call requireAdmin(…,
// 'conversations:read') first. A chat token may read messages by policy, so
// the SQL function refuses it itself (Rule 2); getTranscript() would not, and
// is never handed one.

import { NO_ANSWER } from './constants.js';
import { fromPostgrest } from './platform.js';
import { refusalText } from './refusal.js';
import type { TenantContext } from './types.js';

/** The list's windows, in days. conversation_list() says 30 for anything else. */
export const CONVERSATION_DAYS = [7, 30, 90] as const;
export type ConversationDays = (typeof CONVERSATION_DAYS)[number];

/** One page of the list. The function caps it at 100. */
export const CONVERSATION_PAGE_SIZE = 25;

// What answer.ts saves when a turn fails (the catch in answerQuestionStream):
// the whole reply when nothing streamed, a suffix after a partial one. Written
// here, not imported, so this file reads the transcript without touching the
// write path (plan Rule 4). If answer.ts changes either, change these too.
const FAILED_REPLY = '[no answer — the request failed]';
const INTERRUPTED_SUFFIX = ' […answer interrupted]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `days` as one of the three windows; anything else is 30. */
export function conversationDays(value: unknown): ConversationDays {
  const n = typeof value === 'string' ? Number(value) : value;
  return (CONVERSATION_DAYS as readonly unknown[]).includes(n) ? (n as ConversationDays) : 30;
}

export interface ConversationSummary {
  id: string;
  startedAt: string;
  lastAt: string;
  /** the visitor's messages */
  turns: number;
  /** assistant messages that are the NO_ANSWER marker */
  refusals: number;
  /** the visitor's first message, at most 200 characters; '' if there is none */
  firstQuestion: string;
}

export interface ConversationPage {
  timezone: string;
  days: ConversationDays;
  /** every conversation matching the filters; 0 on a page past the end (the screen keeps the first page's) */
  total: number;
  more: boolean;
  rows: ConversationSummary[];
}

export interface ConversationQuery {
  days?: unknown;
  query?: string | null;
  refused?: boolean;
  /** the previous page's last row: its lastAt and id */
  before?: { lastAt: string; id: string } | null;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** The function's jsonb as a ConversationPage. Exported for the test. */
export function parseConversationPage(raw: unknown): ConversationPage {
  const r = obj(raw);
  const rows = Array.isArray(r.rows) ? r.rows.map(obj) : [];
  return {
    timezone: String(r.timezone ?? 'Asia/Manila'),
    days: conversationDays(num(r.days)),
    total: num(r.total),
    more: r.more === true,
    // Field by field, never spread (rule 7's habit).
    rows: rows.map((c) => ({
      id: String(c.id ?? ''),
      startedAt: String(c.startedAt ?? ''),
      lastAt: String(c.lastAt ?? ''),
      turns: num(c.turns),
      refusals: num(c.refusals),
      firstQuestion: typeof c.firstQuestion === 'string' ? c.firstQuestion : '',
    })),
  };
}

/** One page of this tenant's conversations, newest activity first. */
export async function listConversations(tenant: TenantContext, q: ConversationQuery = {}): Promise<ConversationPage> {
  const query = q.query?.trim() ? q.query.trim().slice(0, 200) : null;
  const before = q.before && UUID.test(q.before.id) && !Number.isNaN(Date.parse(q.before.lastAt)) ? q.before : null;
  const { data, error } = await tenant.db.rpc('conversation_list', {
    p_tenant_id: tenant.id,
    p_days: conversationDays(q.days),
    p_query: query,
    p_refused: q.refused === true,
    p_before_at: before?.lastAt ?? null,
    p_before_id: before?.id ?? null,
    p_limit: CONVERSATION_PAGE_SIZE,
  });
  if (error) throw fromPostgrest(error, 'Could not load the conversations');
  const page = parseConversationPage(data);
  console.log(`[conversations] tenant=${tenant.slug} days=${page.days}${query ? ' query' : ''}${q.refused ? ' refused' : ''}: ${page.rows.length} of ${page.total}`);
  return page;
}

/** What a stored message is. A visitor's is always a question. */
export type MessageKind = 'question' | 'answer' | 'refusal' | 'failed' | 'interrupted';

/** Name a stored message. Exact, like isRefusal(): storedReply() saves the marker exact (D-092). */
export function messageKind(role: 'user' | 'assistant', content: string): MessageKind {
  if (role === 'user') return 'question';
  if (content === NO_ANSWER) return 'refusal';
  if (content === FAILED_REPLY) return 'failed';
  if (content.endsWith(INTERRUPTED_SUFFIX)) return 'interrupted';
  return 'answer';
}

export interface TranscriptMessage {
  id: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  /** as stored; for an interrupted reply, the partial text without the suffix */
  content: string;
  createdAt: string;
  /** a refusal only: has staff marked it resolved in Unanswered (D-045)? null for any other kind */
  resolved: boolean | null;
}

export interface Transcript {
  id: string;
  timezone: string;
  /** what a visitor saw for a refusal: the tenant's English words (D-047); the reply language is not stored */
  fallback: string;
  messages: TranscriptMessage[];
}

/**
 * One conversation, oldest first. `null` when this tenant has no such
 * conversation: another tenant's, a deleted one and a malformed id are the
 * same answer (plan Rule 3), so ids cannot be probed across tenants.
 */
export async function getTranscript(tenant: TenantContext, id: string): Promise<Transcript | null> {
  if (!UUID.test(id)) return null;

  // 1. Is it this tenant's? tenant_id filtered here as well as by RLS (rule 6).
  const { data: owned, error: ownError } = await tenant.db
    .from('conversations')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('id', id)
    .maybeSingle();
  if (ownError) throw new Error(`Could not load the conversation: ${ownError.message}`);
  if (!owned) return null;

  // 2. Its messages, each with its resolution if it is a resolved refusal.
  //    The embed joins on the composite FK (message_id, tenant_id), so it can
  //    only be this message's. A staff token reads resolutions; that is why
  //    this runs on one.
  const { data, error } = await tenant.db
    .from('messages')
    .select('id, role, content, created_at, unanswered_resolutions(resolved_at)')
    .eq('tenant_id', tenant.id)
    .eq('conversation_id', id)
    .order('id', { ascending: true });
  if (error) throw new Error(`Could not load the messages: ${error.message}`);

  // 3. The tenant's timezone, for the times on the page (trap 9): the
  //    bookings config's, Asia/Manila without it, the dashboard's rule.
  const { data: app } = await tenant.db
    .from('tenant_applications')
    .select('config')
    .eq('tenant_id', tenant.id)
    .eq('application_key', 'bookings')
    .maybeSingle();
  const timezone = typeof obj(app?.config).timezone === 'string' ? String(obj(app?.config).timezone) : 'Asia/Manila';

  const messages: TranscriptMessage[] = data.map((m) => {
    const role = m.role as 'user' | 'assistant';
    const kind = messageKind(role, m.content);
    return {
      id: m.id,
      role,
      kind,
      content: kind === 'interrupted' ? m.content.slice(0, -INTERRUPTED_SUFFIX.length) : m.content,
      createdAt: m.created_at,
      // An array of at most one: PostgREST embeds it to-many.
      resolved: kind === 'refusal' ? (m.unanswered_resolutions?.length ?? 0) > 0 : null,
    };
  });
  console.log(`[conversations] tenant=${tenant.slug} transcript: ${messages.length} message(s)`);
  return { id, timezone, fallback: refusalText(tenant), messages };
}
