'use client';

import { useState } from 'react';
import type { Source } from '@rag/pipeline';

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
        <span className="source-title">{source.documentTitle}</span>
        {/* Which of the two searches found this chunk (D-015). Worth showing: a
            'keyword' badge on a chunk with a low similarity score is the hybrid
            search visibly doing the job vector search could not. */}
        <span className={`source-found ${source.foundBy}`} title={FOUND_BY_TITLE[source.foundBy] ?? ''}>
          {source.foundBy}
        </span>
        {/* Three decimals: the difference between 0.42 and 0.45 is the
            difference between a good match and a mediocre one. */}
        <span className="source-score">{source.similarity.toFixed(3)}</span>
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
  searchQuery,
  question,
}: {
  sources: Source[];
  searchQuery: string;
  question: string;
}) {
  if (sources.length === 0) {
    // Not an error. This is the system correctly declining to answer.
    return (
      <details className="sources">
        <summary>No matching chunks above the similarity threshold.</summary>
      </details>
    );
  }

  return (
    <details className="sources">
      <summary>
        {sources.length} source{sources.length === 1 ? '' : 's'}
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
  );
}
