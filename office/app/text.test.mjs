// text.test.mjs — the reply parser (public/text.js) is pure; pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocks, spans } from './public/text.js';

test('spans: bold and code, nothing else; a tag stays text', () => {
  assert.deepEqual(spans('a **b** `c` <script>'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' <script>' }]);
});

test('blocks: paragraphs, a heading, lists, a fence, a pipe table', () => {
  const b = blocks('# Owed\n\nline one\nline two\n\n- a\n- **b**\n\n1. x\n2. y\n\n```\ngit log -1\n```\n\n| id | who |\n|---|---|\n| T-1 | ivy |\n| T-2 | finn |\nafter');
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'ol', 'code', 'table', 'p']);
  assert.equal(b[1].spans[0].text, 'line one line two');
  assert.equal(b[2].items[1][0].bold, true);
  assert.equal(b[4].text, 'git log -1');
  assert.deepEqual(b[5].head.map((c) => c[0].text), ['id', 'who']);
  assert.deepEqual(b[5].rows.map((r) => r[1][0].text), ['ivy', 'finn']);
});

test('blocks: an unclosed fence takes the rest; empty input is no blocks; CRLF is read', () => {
  assert.deepEqual(blocks('```\nx'), [{ type: 'code', text: 'x' }]);
  assert.deepEqual(blocks(''), []);
  assert.deepEqual(blocks('a\r\nb').map((x) => x.spans[0].text), ['a b']);
});
