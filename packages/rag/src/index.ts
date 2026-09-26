// @rag/pipeline — the two pipelines, ingest and query.
//
// Orchestrates @rag/chunker, @rag/openai and @rag/db. Contains no HTTP
// handling: no req, no res, no status codes. It throws; the route layer decides
// what that means to a browser.
//
// Reading order, matching the flowcharts in architecture.md § 3 and flow.md:
//
//   constants.ts   the seven knobs, all measured
//   ingest.ts      text -> chunks -> embeddings -> rows
//   prompt.ts      chunks + history + question -> the messages array
//   retrieve.ts    question -> standalone query -> two searches -> one list
//   answer.ts      the whole query pipeline, streaming and not
//   language.ts    an explicit language request, and the reply to a bare one
//   refusal.ts     the refusal marker swapped for the tenant's friendly words (D-047)
//   dates.ts       relative dates ("bukas", "next Friday") resolved in code
//   tenant.ts      a slug -> the TenantContext every call above requires
//   applications.ts  which applications (bookings, …) a tenant has switched on
//   tools.ts       the tools a tenant's chatbot is offered, and where they run
//   unanswered.ts  the questions the documents could not answer, for staff

export {
  MATCH_COUNT,
  CANDIDATE_COUNT,
  RRF_K,
  MIN_SIMILARITY,
  MAX_HISTORY,
  REWRITE_MAX_TOKENS,
  NO_ANSWER,
  MAX_TOOL_ROUNDS,
  LANGUAGE_SCAN_MESSAGES,
} from './constants.js';

export {
  ingestDocument,
  listDocuments,
  countDocuments,
  deleteDocument,
  getChunks,
  getDocument,
  updateDocument,
} from './ingest.js';
export { buildPrompt } from './prompt.js';
export { classifySmallTalk, greetingReply, greetingText, smallTalkLanguage, smallTalkReply, thanksPrefix } from './greeting.js';
export type { SmallTalk } from './greeting.js';
export {
  detectLanguage,
  languageInstructions,
  languagePreference,
  languageRequest,
  replyLanguage,
  requestReply,
} from './language.js';
export type { LanguageChoice, LanguagePreference } from './language.js';
export { addDays, asksAvailability, dateInstructions, isDateOnly, MAX_DATE_CHECKS, planDates, resolveDates } from './dates.js';
export type { DateMention, DatePlan } from './dates.js';
export { rewriteQuestion, retrieve } from './retrieve.js';
export { answerQuestion, answerQuestionStream, getMessages } from './answer.js';
export { DEFAULT_REFUSALS, displayReply, isRefusal, refusalFilter, refusalText } from './refusal.js';
export { loadTenant } from './tenant.js';
export { APPLICATIONS, enabledApplications } from './applications.js';
export { executeTool, toolsFor } from './tools.js';
export { listUnanswered, reopenUnanswered, resolveUnanswered, UNANSWERED_LIMIT } from './unanswered.js';
export type { PromptTools, TenantTools, ToolExecution } from './tools.js';
export type { ApplicationKey } from './applications.js';

export type {
  Answer,
  ChunkSummary,
  DocumentDetail,
  FallbackMessages,
  DocumentSummary,
  FoundBy,
  HistoryMessage,
  IngestResult,
  RetrievedChunk,
  Source,
  StreamMeta,
  TenantContext,
  ToolCallRecord,
  UnansweredQuestion,
} from './types.js';
