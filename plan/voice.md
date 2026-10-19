# Voice plan: talk to the assistant, and hear it answer

> **Status: planned 2026-10-20, nothing built.** Branch `feat/voice` when
> started. The record will be D-134 and R-53. § 6 holds the questions, each
> with a recommendation; Phase 0 waits for the answers.

The user: "add option to talk with the chatbot. chatbot response is also to
talk." A guest on `/t/<slug>` presses a microphone, speaks, and the assistant
answers aloud as well as on screen. Typing stays exactly as it is.

| | |
|---|---|
| **In scope** | A microphone button in the composer. The recording becomes text on the server (OpenAI transcription), and that text goes through the **unchanged** pipeline: rewrite, retrieval, the grounding prompt, the tools, the refusal. The reply is shown as today and, when the guest has voice replies on, spoken (OpenAI text-to-speech). A speaker toggle, a Stop button, the states (listening, transcribing, thinking, speaking). A per-tenant feature switch. The privacy notice and the legal texts. |
| **Out of scope** | Speech-to-speech models (OpenAI Realtime): the model would answer from the audio, past `buildPrompt()`, so the grounding, the tools and the battery would not apply (Rule 1). Wake words and always-on listening. Phone calls. Voice on the staff screens or the booking page. Keeping recordings. Choosing a voice per tenant (§ 6 q5 says when). |

---

## 0. The rules

### Rule 1 — Voice is a way in and a way out, never a second pipeline

Audio becomes text before the pipeline and text becomes audio after it.
Between the two, nothing changes: the same `answer()`, the same prompt,
the same tools, the same `NO_ANSWER` refusal, the same stored messages. So:
- `buildPrompt()`, `language.ts` and `dates.ts` are not edited, and the
  three prompt baselines stay byte-identical (CLAUDE.md rule 1);
- a spoken question is stored as its transcript, exactly as if it had been
  typed, and staff read it on S-16 like any other;
- what is spoken is what the screen shows, made speakable (Rule 3), never
  a second model call that could say something else.

### Rule 2 — The open route speaks only the conversation's own reply

The chat is open (D-037), so both voice routes are too. A route that turns
ANY text into speech would be free text-to-speech on the tenant's OpenAI
key for anyone who finds it. So `POST /voice/speak` takes a
`conversationId`, never text. It reads that conversation's latest assistant
message on the chat token (rule 6's two walls: `.eq('tenant_id')` and RLS)
and speaks that. "Not yours" and "not there" are the same 404.

`POST /voice/transcribe` takes audio and returns text only; it never
answers, so it adds no path around the chat route's limits.

### Rule 3 — Speak what a person would say, not the markup

A reply can hold a pipe table (D-091), `**bold**`, emoji (D-092), room
cards (D-094) and the stored refusal marker (D-047). One pure function,
`speakable(text)`, in `packages/rag/src/speakable.ts`, browser-safe and
tested:
- the refusal marker becomes the tenant's own fallback words
  (`displayReply()`), never "NO_ANSWER";
- a table is not read cell by cell: its rows' first cells are named
  ("Casa Uno, Casa Dos and Familia"), followed by "The details are on
  your screen." (§ 6 q3);
- `**` markers, emoji and URLs are dropped; prices stay ("₱3,500.00" is
  read by the voice as an amount, which Phase 0 checks);
- it is capped at `MAX_SPOKEN_CHARS` (in `constants.ts`), ending on a
  sentence and "The rest is on your screen."

### Rule 4 — No recording is kept, and the notice says so before the first one

The audio goes from the browser to our route to OpenAI, in memory, and is
dropped. Nothing is written to Storage or the database but the transcript,
which is the message. The composer's notice (D-129, page text) and
`lib/legal.ts` say that voice is sent to OpenAI to be transcribed and is
not kept. The browser's own microphone prompt comes only after the guest
presses the button.

### Rule 5 — Each limit is the server's

- A recording is at most `MAX_RECORDING_SECONDS` (30) and
  `MAX_AUDIO_BYTES` (1 MB). The route checks the size and the type by
  the bytes (the `payments.ts` pattern), not by the browser's word.
- Both routes go through the per-IP window (`lib/rate-limit.ts`), with
  its own keys. This is the WEAK limit (R-39), so R-53 records what a
  determined caller can still spend.
- Off by the feature switch, both routes 404 and the button is not drawn
  (`requireFeature('voice')`, D-127).

---

## 1. What changes, by layer

| Layer | Change |
|---|---|
| `@rag/openai` | `transcribe(audio, mime, language?)` → text, a multipart POST to `/v1/audio/transcriptions`; `speak(text, voice)` → an audio `Response` body, a POST to `/v1/audio/speech`. Raw `fetch`, like the rest (D-001). Models from `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_TTS_MODEL`, read per call like the chat model. `[openai]` log lines with the duration and characters, for cost |
| `@rag/pipeline` | `speakable()` (Rule 3) and `latestReply(tenant, conversationId)` (Rule 2). Nothing else |
| `apps/web` routes | `POST /api/t/<slug>/voice/transcribe` (multipart, one file) → `{ text }`; `POST /api/t/<slug>/voice/speak` `{ conversationId }` → `audio/mpeg`, streamed. Both `withTenantRoute()`, `requireFeature('voice')`, the per-IP window, no `requireAdmin()` (open, like `chat/`) |
| `apps/web` chat | `components/voice.tsx`: the mic button (MediaRecorder, `audio/webm` or Safari's `audio/mp4`), the level meter while listening, the speaker toggle (remembered in `localStorage`, per viewer), Stop, and one `<audio>` element that plays replies. After a spoken question the transcript goes into the field and is SENT (§ 6 q1), so the screen always shows what was heard |
| Features | `voice` in `lib/features.ts` and `tenant_features`' check (a 41st SQL file, `schema-voice.sql`, the one-line constraint change) |
| Legal | The notice under the field, `lib/legal.ts`' privacy text, the policy version bumped |
| Not touched | The prompt, the tools, `answer()`, the stored messages' shape, the booking page, staff screens, `language.ts`, `dates.ts` |

## 2. The flow

```
press mic → browser asks for the microphone (first time) → listening (meter, Stop, 30 s cap)
  → POST voice/transcribe (audio) → { text } → shown in the field → sent as a typed question
  → chat/ (unchanged) → the reply streams onto the screen as today
  → when the stream ends and voice replies are on: POST voice/speak { conversationId }
  → audio plays; Stop or a new question ends it
```

The reply is spoken after it is complete, not sentence by sentence. Speaking
while it streams would need the speak route to take text (Rule 2 forbids it)
or to read a message not yet stored. Phase 0 measures the wait; if it is too
long, § 6 q4 is the way to shorten it.

A browser's autoplay rule allows sound only after a gesture on the page. The
mic press is one, so a spoken question's answer may play. A TYPED question's
answer is spoken only if the guest has turned voice replies on with the
speaker toggle, which is a gesture too.

---

## 3. Phases

### Phase 0 — Baseline and the measurements
- tests, typecheck, verify, rooms; the three prompt baselines diffed
  (northwind's and harbor's are gone with their tenants, 2026-10-20: villa's
  tool text and a fresh villa prompt snapshot become this plan's baselines);
- a spike in `plan/voice-phase0-spike.mjs`, no UI: transcribe three
  recordings (English, Tagalog, Taglish: "May bakante ba kayo bukas?") and
  speak three replies (an English price, a Taglish answer, a refusal):
  - record each transcript, its seconds and its cost;
  - the wait from the end of a reply to the first sound;
  - whether "₱3,500.00" and Tagalog words are read acceptably, judged by
    the user from the saved files.

### Phase 1 — `@rag/openai` and `speakable()`
`transcribe()`, `speak()`, unit tests on a fake `fetch` (the request shape,
the errors in words). `speakable()` with tests for every shape in Rule 3,
on real stored replies from villa (a table, a refusal, an emoji, a room
list).

### Phase 2 — The two routes
Both routes, `latestReply()` on the chat token. HTTP walk
(`plan/voice-phase2-walk.mjs`, needs `pnpm dev`): transcribe a WAV; a 2 MB
file, a text file renamed `.webm`, and a 31 s recording refused in words;
speak villa's own conversation; another tenant's `conversationId` is the
same 404 as a missing one; the eleventh call in the window is a 429; the
feature off is a 404.

### Phase 3 — The chat screen
`voice.tsx`, the button, the states, the toggle, Stop, the notice. A
browser walk with Chrome's fake microphone
(`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`):
press, the field fills, the reply appears and plays (the `<audio>` reaches
`playing`), Stop silences it, New chat stops it. Keyboard: the mic is a
button with a name, Space starts and stops, Escape stops. axe over the
idle, listening and speaking states, light and dark, 1280 and 375
(`plan/ui-refresh-a11y.mjs` stays at 0). A denied microphone says how to
allow it, in words, and typing still works.

### Phase 4 — The switch and the legal text
`voice` in the registry and SQL (applied by Claude), the platform form's
Features tab shows it; verify checks: only a super user writes it, the
routes 404 with it off. The notice and the privacy text. The bundle grep
(rule 2) still prints nothing.

### Phase 5 — The walls and the battery
- `pnpm --filter @rag/pipeline isolation` cannot run (northwind is gone);
  instead verify gets the two-wall checks of `latestReply()`: an
  unfiltered read under villa's chat token sees no alteza message, and
  the code filter alone (service client) returns null for alteza's id;
- `pnpm eval` cannot run either; Rule 1 is proved instead by the prompt
  snapshot being byte-identical, and by a transcript answered exactly as
  the same typed text (the same retrieval line in the log).

### Phase 6 — The walk
The user, on a phone, on alteza: ask "What rooms do you have?" aloud and
hear the room list summarised; ask a Taglish question; ask something the
documents do not hold and hear the tenant's fallback; turn voice replies
off and type.

### Phase 7 — The record
D-134 (voice in and out, around the unchanged pipeline), R-53 (cost on an
open route; audio leaves through OpenAI), CLAUDE.md (the header paragraph,
the routes, the 41st SQL file, the new env vars), `flow.md`, `status.md`,
`whats-done.md`.

---

## 4. Risks this plan records (R-53)

- **Cost on an open route.** Each spoken turn costs a transcription and a
  speech call on top of the chat call. The per-IP window is per instance
  and in memory (R-39); a caller rotating addresses can still spend. The
  caps (30 s, 1 MB, `MAX_SPOKEN_CHARS`) bound one call, not the total.
- **Audio leaves through OpenAI.** Disclosed in the notice before the
  first recording; nothing is kept here. A tenant that cannot accept it
  turns the feature off.
- **A wrong transcript is a wrong question.** The transcript is shown in
  the field and in the conversation, so a guest sees what was heard; the
  answer is to the text, and the refusal still holds.

## 5. Not covered here

A spoken booking (the chat does not book, D-069), reading the sources
panel aloud, and translation: the reply language is still decided in code
from the question (D-043).

---

## 6. Questions (recommendations first)

1. **After speaking, send at once or wait?** Recommendation: **send at
   once**, with the transcript shown as the question. It is what "talk to
   it" means. The alternative, filling the field to be checked and sent,
   is one more tap per turn.
2. **Hold to talk, or tap to start and tap to stop?** Recommendation:
   **tap to start, tap (or 30 s, or silence) to stop**. Holding is awkward
   on a phone and impossible by keyboard.
3. **A table aloud:** Recommendation: **name the rows, then "the details
   are on your screen"** (Rule 3). Reading prices cell by cell takes a
   minute and is hard to follow.
4. **Speak while the reply is still arriving?** Recommendation: **not in
   this plan.** Rule 2 keeps the speak route to stored text. If Phase 0's
   wait is too long, a later plan can speak the first sentences of a
   reply as they are stored.
5. **One voice for every tenant?** Recommendation: **yes, one** (set in
   `constants.ts`), until a tenant asks. A per-tenant voice is a
   `tenants` column and a platform form field.
6. **On for every tenant when shipped?** The registry's rule is "no row =
   ON" (D-127). Recommendation: **ship it OFF by default for this one
   feature** (a `defaultOn: false` in the registry), because it adds cost
   and sends audio to a third party; a super user turns it on per tenant.
