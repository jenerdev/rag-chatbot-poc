// prompt.ts — the function frameworks hide.

import type { ChatMessage } from '@rag/openai';
import { NO_ANSWER } from './constants.js';
import type { PromptTools } from './tools.js';
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
 *
 * TOOLS (D-036, plan/bookings.md § 2.5): when the tenant has tools, one more
 * block is appended AFTER `--- END CONTEXT ---`, and only then. The grounding
 * block is not touched. For a tenant without tools, `tools` is null and the
 * output is the same string it was before tools existed, byte for byte.
 * `pnpm --filter @rag/pipeline prompt-snapshot` diffed against
 * plan/baseline/northwind-prompt-pre-bookings.txt is the proof.
 *
 * The block says a tool result is context too, so D-017's rules (connect,
 * never add, say what is missing) apply to it without being restated. The
 * tool-specific lines come from tools.ts, because only that file knows which
 * tools this tenant has.
 *
 * DATES (D-046): on a turn whose message has a relative date in it, the
 * tools block's last lines state what it resolves to ("bukas" means
 * 2026-09-28). The lines come from dates.ts, which does the arithmetic in
 * code; a message with no date adds nothing.
 *
 * LANGUAGE (D-043): one more block, LAST, and only when the reply is not an
 * unrequested English one. The same shape as the tools block: the lines come
 * from language.ts, which decides the language in code, so this function
 * only places them. Last, so they cover every example above them, the tools
 * block's English one included. An English turn gets no block, so every
 * English prompt is the string it was before D-043 (the northwind snapshot
 * is the proof). Without the block, the model mirrored the user: a Tagalog
 * question got formal, pure Tagalog, and a Taglish one got plain English
 * (plan/baseline/eval-lang-before.txt).
 */
export function buildPrompt(
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
  chunks: { content: string }[],
  history: HistoryMessage[],
  question: string,
  tools: PromptTools | null = null,
  language: string[] = [],
): ChatMessage[] {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');

  // Appended after the context block, never inside the grounding block above it.
  const toolBlock = tools
    ? [
        '',
        'You can also call tools. A tool result is context too, and every rule',
        'above applies to it.',
        ...tools.instructions,
        `Today is ${tools.today} (${tools.weekday}), ${tools.timezone}.`,
        // Right after today, and only on a turn with a date in it (D-046).
        ...(tools.dates ?? []),
      ]
    : [];

  // Appended last, and only when there is something to say (D-043).
  const languageBlock = language.length > 0 ? ['', ...language] : [];

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
        // D-092: an emoji where one fits, as an example of what to write
        // (D-017), with the two places it must not go: a table cell (the
        // amount column is found by its first character) and the exact
        // refusal (isRefusal() tolerates one anyway). Changes northwind's
        // snapshot by design: the baseline is northwind-prompt-post-emoji.txt.
        'Add an emoji where it fits the sentence, for example 👋 in a greeting,',
        '✅ when something is open or allowed, ❌ when it is taken or not',
        'allowed, 📅 beside a date, 💰 beside a price; one or two per reply at',
        'most. Never inside a table cell, and none in the exact reply above.',
        '',
        '--- CONTEXT ---',
        context,
        '--- END CONTEXT ---',
        ...toolBlock,
        ...languageBlock,
      ].join('\n'),
    },
    ...history, // oldest first, so the conversation reads in order
    { role: 'user', content: question },
  ];
}
