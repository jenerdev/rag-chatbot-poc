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
//   tenant.ts      a slug -> the TenantContext every call above requires

export {
  MATCH_COUNT,
  CANDIDATE_COUNT,
  RRF_K,
  MIN_SIMILARITY,
  MAX_HISTORY,
  REWRITE_MAX_TOKENS,
  NO_ANSWER,
} from './constants.js';

export { ingestDocument, listDocuments, countDocuments, deleteDocument, getChunks } from './ingest.js';
export { buildPrompt } from './prompt.js';
export { greetingReply, greetingText } from './greeting.js';
export { rewriteQuestion, retrieve } from './retrieve.js';
export { answerQuestion, answerQuestionStream, getMessages } from './answer.js';
export { loadTenant } from './tenant.js';

export type {
  Answer,
  ChunkSummary,
  DocumentSummary,
  FoundBy,
  HistoryMessage,
  IngestResult,
  RetrievedChunk,
  Source,
  StreamMeta,
  TenantContext,
} from './types.js';
