// prompt.ts — the function frameworks hide.

import type { ChatMessage } from '@rag/openai';
import { NO_ANSWER } from './constants.js';
import type { HistoryMessage, TenantContext } from './types.js';

/**
 * Assemble the messages array sent to the chat model.
 *
 * This is the function frameworks hide, and it is the heart of RAG. Read it and
 * the "magic" disappears: the retrieved chunks are pasted into the system
 * message as plain text. There is no special knowledge-base channel into the
 * model. That is the entire trick (architecture.md § 6).
 *
 * ⚠️ `CLAUDE.md`: **re-run the eval battery after any edit to this function.**
 * Phase 5.5 measured that this wording, not the similarity threshold, is what
 * prevents invention — and a change that makes the bot more helpful can quietly
 * make it answer from training data instead.
 *
 * TENANCY (D-029): the persona is ONE line ABOVE the grounding block, and the
 * grounding block below it is byte-identical to D-017's measured wording. A
 * persona is an invitation to be helpful, and helpfulness is how refusals erode
 * (plan.md § 2.6). So it names who is speaking and nothing else. It says
 * nothing about tone, eagerness or expertise. Phase 4 measured it against the
 * six Northwind verdicts before it was kept.
 */
export function buildPrompt(
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
  chunks: { content: string }[],
  history: HistoryMessage[],
  question: string,
): ChatMessage[] {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');

  return [
    {
      // This block is the correctness gate, and Phase 5 measured it failing in
      // BOTH directions, which is why it is worded the way it is.
      //
      // Too loose (5.5, instruction removed): the bot answered "the capital of
      // France is Paris" and produced a 400-word sourdough recipe while citing
      // lab-handbook chunks. Outside knowledge leaking in.
      //
      // Too strict (the original "Do not use outside knowledge. Do not guess."):
      // it refused "who do I contact on extension 4417?" even with the chunk
      // reading "...liaison, currently reachable at extension 4417" in front of
      // it, because answering needs one step of joining two stated facts. And
      // at MATCH_COUNT=1 it invented a reason for the Quiet Hour rather than
      // admit the retrieved chunk only held half the answer.
      //
      // So the wording now separates three things that "do not guess" had
      // collapsed into one: CONNECTING facts that are present (allowed),
      // ADDING facts that are absent (never), and PARTIAL answers (say what is
      // missing rather than invent it). D-017.
      role: 'system',
      content: [
        // The persona. Everything after the blank line is the D-017 block,
        // unchanged. If a future edit makes this line longer, re-run the eval.
        `You are ${tenant.assistantName}, the assistant for ${tenant.businessName}.`,
        '',
        'You answer questions using ONLY the context below.',
        '',
        'You may connect facts that the context states. If the context says a',
        'person is reachable at an extension, you may answer a question about',
        'who to contact on that extension. Resolving a reference the user made',
        'earlier in the conversation is also allowed.',
        '',
        'You may NOT add any fact the context does not state. Never fall back',
        'on outside knowledge, no matter how confident you are.',
        '',
        'If the context answers only part of the question, give that part and',
        'say plainly which part the documents do not cover. Never fill a gap',
        'with something plausible.',
        '',
        'If the context does not answer the question at all, reply exactly:',
        `"${NO_ANSWER}"`,
        '',
        '--- CONTEXT ---',
        context,
        '--- END CONTEXT ---',
      ].join('\n'),
    },
    ...history, // oldest first, so the conversation reads in order
    { role: 'user', content: question },
  ];
}
