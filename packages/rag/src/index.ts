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
//   features.ts    which features a tenant has switched OFF (D-127; on by default)
//   tools.ts       the tools a tenant's chatbot is offered, and where they run
//   unanswered.ts  the questions the documents could not answer, for staff
//   conversations.ts  every chat of a tenant, listed and read back, for staff (D-115)
//   activity.ts    who did what: the audit log and the stay log, listed for owners and the platform (D-138)
//   voice.ts       the latest reply of a conversation, for the speak route (D-134)
//   platform.ts    what a super user does to tenants: list, create, edit, archive, applications
//   members.ts     who administers a tenant and as what, for owners and the platform alike

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
export { addDays, asksAvailability, asksUndatedPrice, PRICE_NEEDS_DATE, dateInstructions, isDateOnly, MAX_DATE_CHECKS, planDates, resolveDates } from './dates.js';
export type { DateMention, DatePlan } from './dates.js';
export { rewriteQuestion, retrieve } from './retrieve.js';
export { answerQuestion, answerQuestionStream, getMessages } from './answer.js';
export { DEFAULT_REFUSALS, displayReply, isRefusal, refusalFilter, refusalText } from './refusal.js';
export { loadTenant } from './tenant.js';
export { APPLICATIONS, enabledApplications } from './applications.js';
export { featureSwitches } from './features.js';
export { rolePermissionRows, setRolePermissions } from './role-permissions.js';
export type { RolePermissionRow } from './role-permissions.js';
export { executeTool, toolsFor } from './tools.js';
export { listUnanswered, reopenUnanswered, reopenUnansweredMany, resolveUnanswered, resolveUnansweredMany, UNANSWERED_LIMIT } from './unanswered.js';
export {
  archiveTenant,
  createTenant,
  fromPostgrest,
  getTenant,
  listTenants,
  PlatformConflictError,
  PlatformForbiddenError,
  PlatformInputError,
  PlatformNotFoundError,
  removeApplication,
  setFeature,
  platformTenantContext,
  setApplication,
  updateTenant,
} from './platform.js';
export type { NewTenant, PlatformContext, TenantDetail, TenantPatch, TenantSummary } from './platform.js';
export { BRAND_BUCKET, BRAND_IMAGE_KINDS, brandObjectPath, MAX_BRAND_BYTES, sweepBrandImages, uploadBrandImage } from './brand-images.js';
export type { BrandImageKind } from './brand-images.js';
export { addMember, listMembers, removeMember, setMemberRole } from './members.js';
export { CONVERSATION_DAYS, CONVERSATION_PAGE_SIZE, conversationDays, getTranscript, listConversations, messageKind } from './conversations.js';
export type { ConversationDays, ConversationPage, ConversationSummary, MessageKind, Transcript, TranscriptMessage } from './conversations.js';
export { ACTIVITY_AREAS, ACTIVITY_DAYS, ACTIVITY_PAGE_SIZE, activityArea, activityDays, listActivity, parseActivityPage } from './activity.js';
export type { ActivityArea, ActivityDays, ActivityPage, ActivityQuery, ActivityRow } from './activity.js';
export { latestReply, voiceVocabulary } from './voice.js';
export { DASHBOARD_DAYS, dashboardDays, platformDashboard, tenantDashboard } from './dashboard.js';
export type { PlatformPulse, TenantDashboard } from './dashboard.js';
export type { Member } from './members.js';
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
  RoomCard,
  Source,
  StreamMeta,
  TenantContext,
  ToolCallRecord,
  UnansweredQuestion,
} from './types.js';
