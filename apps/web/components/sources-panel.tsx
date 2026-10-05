'use client';

import { useState } from 'react';
import type { Source, ToolCallRecord } from '@rag/pipeline';
import { Icon } from './icons';

// The look (plan/ui-refresh.md Phase 4): ONE footer style for "what this
// answer was built from". The availability evidence stays OPEN (CLAUDE.md
// rule 7, D-037: it is the answer's basis); the chunks are a quiet
// "N sources" line that opens into cards, each with its score drawn as a
// <meter> beside the number.

const FOUND_BY_TITLE: Record<string, string> = {
  vector: 'Found by semantic similarity',
  keyword: 'Found by exact keyword match — vector search missed this',
  both: 'Found by both searches',
};

/**
 * One retrieved chunk. Click the text to read it in full.
 *
 * Seeing the whole chunk is what tells you whether the answer was really in
 * there — a truncated preview can look convincing while the sentence that
 * mattered is two lines further down.
 */
function SourceBox({ source }: { source: Source }) {
  const [truncated, setTruncated] = useState(true);

  return (
    <div className="source">
      <div className="source-head">
        <span className="source-title">
          <Icon name="file" size={14} />
          {source.documentTitle}
        </span>
        {/* Which of the two searches found this chunk (D-015). Worth showing: a
            'keyword' badge on a chunk with a low similarity score is the hybrid
            search visibly doing the job vector search could not. */}
        <span className={`source-found ${source.foundBy}`} title={FOUND_BY_TITLE[source.foundBy] ?? ''}>
          {source.foundBy}
        </span>
        {/* Three decimals: the difference between 0.42 and 0.45 is the
            difference between a good match and a mediocre one. */}
        <span className="source-score">
          {/* The bar is the number again, for the eye; the number is what is read. */}
          <meter min={0} max={1} value={Math.max(0, Math.min(1, source.similarity))} aria-hidden="true" />
          {source.similarity.toFixed(3)}
        </span>
      </div>
      <p
        className={`source-text${truncated ? ' truncated' : ''}`}
        title="Click to expand"
        onClick={() => setTruncated((t) => !t)}
      >
        {source.content}
      </p>
    </div>
  );
}

/** One availability row, as check_availability returns it. No guest fields exist to render. */
interface SlotRow {
  date: string;
  unit: string;
  slot: string;
  status: 'open' | 'taken';
}

/** "Thu 8 Oct". A calendar date, so formatted as UTC. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * One tool call: what was asked, and exactly what came back.
 *
 * D-012's argument, extended to tools (D-037). An answer built from a tool
 * result is only checkable if the result is on screen. If the model says
 * "open" and the row says "taken", this is where you see it. It is also where
 * a date the model resolved wrongly ("this Saturday", R-15) becomes visible
 * instead of silent. The dates shown are the ones the model sent, not the
 * ones the user typed.
 *
 * Everything is a React child, so it is escaped. The result has no guest data
 * to show: check_availability never returns any (Rule 3).
 */
function ToolCallBox({ call }: { call: ToolCallRecord }) {
  const result = call.result as { slots?: SlotRow[]; error?: string } | null;
  const from = typeof call.args?.date_from === 'string' ? call.args.date_from : null;
  const to = typeof call.args?.date_to === 'string' && call.args.date_to !== from ? call.args.date_to : null;

  if (call.name !== 'check_availability') {
    // A tool this screen does not know how to draw. Show it raw, never hide it.
    return (
      <div className="tool-call">
        <div className="tool-head">{call.name}</div>
        <pre className="chunk-text">{JSON.stringify({ args: call.args, result: call.result }, null, 2)}</pre>
      </div>
    );
  }

  // Group the rows by date, in the order they came back.
  const byDate = new Map<string, SlotRow[]>();
  for (const row of result?.slots ?? []) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  const multipleUnits = new Set((result?.slots ?? []).map((r) => r.unit)).size > 1;

  return (
    <div className="tool-call">
      <div className="tool-head">
        <Icon name="calendar" size={14} />
        Checked availability
        <span className="muted">
          {' '}
          · {from ? dayLabel(from) : '(no date)'}
          {to ? ` – ${dayLabel(to)}` : ''}
        </span>
      </div>
      {result?.error ? (
        <div className="tool-error">{result.error}</div>
      ) : (
        [...byDate.entries()].map(([date, rows]) => (
          <div className="day-head" key={date}>
            <span className="day-label">{dayLabel(date)}</span>
            <span className="day-slots">
              {rows.map((r) => (
                <span key={`${r.unit}/${r.slot}`} className={`slot-chip ${r.status}`}>
                  {multipleUnits ? `${r.unit} · ` : ''}
                  {r.slot}: {r.status}
                </span>
              ))}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The sources panel for one answer.
 *
 * This is a required feature, not a debug aid (D-012). It is the only way to
 * tell "the bot read my document" from "the model happened to know this" —
 * without it, a wrong answer is a mystery instead of something you can
 * diagnose in two seconds.
 */
export function SourcesPanel({
  sources,
  toolCalls,
  searchQuery,
  question,
}: {
  sources: Source[];
  toolCalls: ToolCallRecord[];
  searchQuery: string;
  question: string;
}) {
  // Tool calls are shown OPEN, not inside the collapsed <details>. For an
  // availability answer, the tool result is the whole basis of the answer,
  // and the retrieved chunks are background. So they are the part to see
  // without clicking.
  const checked =
    toolCalls.length > 0 ? (
      <div className="checked">
        {toolCalls.map((call, i) => (
          <ToolCallBox key={i} call={call} />
        ))}
      </div>
    ) : null;

  if (sources.length === 0) {
    // Not an error. This is the system correctly declining to answer, or, with
    // a tool call above it, answering from the tool instead (D-035).
    return (
      <>
        {checked}
        <p className="sources-none">
          <Icon name="info" size={14} />
          No matching chunks above the similarity threshold.
        </p>
      </>
    );
  }

  return (
    <>
      {checked}
      <details className="sources">
        <summary>
          <Icon name="file" size={14} />
          {sources.length} source{sources.length === 1 ? '' : 's'}
          <Icon name="chevron-down" size={14} className="sources-chevron" />
        </summary>

        {/* If the search used different words from the ones typed, say so.
            Retrieval quietly searching for something other than the question is
            exactly the kind of thing that should be visible (D-016, same
            argument as D-012). */}
        {searchQuery && searchQuery !== question && (
          <p className="rewrite-note">searched for: {searchQuery}</p>
        )}

        {sources.map((source) => (
          <SourceBox key={source.id} source={source} />
        ))}
      </details>
    </>
  );
}
