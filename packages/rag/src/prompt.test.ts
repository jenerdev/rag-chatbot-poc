// buildPrompt()'s tools block (D-036). The battery measures behaviour; this
// pins the STRING, so a later edit that moves the block, or leaks it into a
// tenant with no tools, fails here, for free, before anyone runs the eval.

import { describe, expect, it } from 'vitest';
import { buildPrompt } from './prompt.js';
import type { PromptTools } from './tools.js';

const TENANT = { assistantName: 'Lia', businessName: 'Villa Amihan Private Resort' };
const CHUNKS = [{ content: 'Check-in is at 2 PM.' }];
const TOOLS: PromptTools = {
  instructions: ['For whether a date or slot is open, ALWAYS call check_availability.'],
  today: '2026-09-24',
  weekday: 'Thursday',
  timezone: 'Asia/Manila',
};

const system = (tools: PromptTools | null | undefined) =>
  buildPrompt(TENANT, CHUNKS, [], 'Is the 12th free?', tools ?? undefined)[0]!.content as string;

describe('buildPrompt with and without tools', () => {
  it('no tools: the same string as the four-argument call (plan/bookings.md Rule 1)', () => {
    const fourArgs = buildPrompt(TENANT, CHUNKS, [], 'Is the 12th free?');
    expect(buildPrompt(TENANT, CHUNKS, [], 'Is the 12th free?', null)).toEqual(fourArgs);
    expect(fourArgs[0]!.content).not.toContain('tool');
  });

  it('tools: the block comes AFTER the context, and the grounding block is untouched', () => {
    const withTools = system(TOOLS);
    const without = system(null);

    // Everything up to and including END CONTEXT is byte-identical.
    expect(withTools.startsWith(without)).toBe(true);
    const block = withTools.slice(without.length);
    expect(block).toContain('A tool result is context too');
    expect(block).toContain('ALWAYS call check_availability');
  });

  it("tools: today's date, weekday and timezone are stated, because the model has no clock (§ 2.3)", () => {
    expect(system(TOOLS)).toContain('Today is 2026-09-24 (Thursday), Asia/Manila.');
  });

  it('the refusal instruction still ends the grounding block, above the tools block', () => {
    const text = system(TOOLS);
    expect(text.indexOf("I don't know based on the documents I have.")).toBeLessThan(text.indexOf('You can also call tools'));
  });
});
