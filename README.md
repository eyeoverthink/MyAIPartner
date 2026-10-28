# My AI Partner

Chandra's responsive workspace, connected to its local agent runtime and the optional fraymus-voice bridge. Chat fills the window, responses use readable Markdown with scrollable code and tables, and the composer stays visible. React and the response renderer are bundled locally, with no runtime CDN or browser Babel dependency.

Navigation has four destinations: **Chat**, **History**, **Tasks** and **Settings**.
On narrow screens, open the navigation menu in the header. History holds browser
conversations and durable server receipts; Tasks holds the real local scheduler.
Settings groups model, appearance, run limits, file handling, voice and advanced
desktop access. Transport Lab, Legacy Mesh, Simulations and canned Demo mode are
removed. A saved Demo preference migrates to Agent mode.

Agent approvals also support a related `workspace.patch` across 2–8 existing
files. The preview shows every file's exact literal hunks, hashes and byte counts
under one approval. Writes are sequential; cancellation or an external conflict
can leave a partial change. Durable receipts show each verified, unattempted or
unknown file. Partial/unknown outcomes stop without automatic retry or rollback;
any repair needs a fresh exact approval. Run inspection retains the latest patch
receipt after cancellation. See [coding boundaries](https://github.com/eyeoverthink/Chandra/blob/main/docs/coding.md).

Install and build with Node.js 20.19+ or 22.12+:

```sh
npm ci
npm test
npm run build
```

Chandra serves `dist/` directly at [http://127.0.0.1:8787/](http://127.0.0.1:8787/), with `/partner/` kept as a compatible URL. For frontend development, start the Chandra server separately, then run `npm run dev` and open [http://127.0.0.1:4178/partner/](http://127.0.0.1:4178/partner/). Vite binds loopback and proxies `/api` to port 8787. Opening `index.html` as a file is no longer supported.

Use **Settings → Models & connection** to select a mode:

- **Agent** is the default. Models and tools come from `/api/agent/capabilities`. Runs show durable progress, tool arguments/results, token usage, known or unknown cost, and exact approval previews. Errors remain errors; they never silently turn into demo replies.
- **Direct** chats with a selected local Ollama model without tools. The NDJSON decoder preserves split JSON and Unicode. Optional bridge memory recall has a short deadline; speech and the complete conversation observation run only after model completion.

A valid saved model selection is retained. Otherwise the interface chooses the server's preferred local model, then the smallest allowed local model with advertised tools (unknown sizes sort last). Cloud is never chosen automatically. Detailed model options in Settings show size and advertised chat/tool/vision support. Initial greetings are labeled Welcome; they do not claim a model call. Appearance follows the system theme unless Light or Dark is selected.

**New chat** archives the current conversation before switching. **History**
restores validated display text, retaining local-only privacy flags without
restoring grants or run authority. Archive errors leave the current chat open;
export it if the browser archive reaches its 100-conversation or 2 MiB limit.
Scrolling up pauses automatic scrolling; **Jump to latest** resumes it.
External response images are click-only references and are never loaded automatically.

In Agent mode, **Image handling → Local vision helper (Gemma3)** explicitly lets
a local text agent ask the configured local helper about uploaded PNG/JPEG images.
The primary receives references and fallible observations, without image pixels.
Both helper input and output share the run's token limits, and the conversation
stays local. Exact text and small details can be misread; no desktop capture is
performed. Automatic image routing is the default: it uses the selected vision
model, otherwise an available local helper or local English OCR for a local
Ollama model. It never changes the primary model or enables cloud. Manual choices
remain exact, and recovery retains the original image mode. See
[helper behavior and measured limits](https://github.com/eyeoverthink/Chandra/blob/main/docs/local-vision.md).

Interrupted agent reads retry with bounded backoff while keeping cancellation and approval controls available. After retry exhaustion or a page reload, an unresolved request remains visible with **Resume existing run** and **Cancel existing run**. New tasks are blocked until that request is resolved. Recovery uses durable GET events; if the initial creation receipt was lost, an explicit **Recover or retry original request** action reuses the original request ID and exact payload under the server's idempotency contract. The client never automatically POSTs another task after a read failure.

In Agent mode, **History → Agent runs & receipts → Inspect receipts** replays a completed, failed or cancelled run from the backend. It shows the stored goal, model, date, response, tool results and usage without submitting a task or duplicating the chat answer. History inspection is disabled during unresolved work and its reads stop when the mode changes or the interface closes.

The **Tasks** page reads the local task API when opened. Enter a
separate title/goal, select a local Ollama model, choose a one-time, interval,
daily or weekly schedule, and set total run/token limits. Preview displays the
server's canonical spec, per-run reservation and exact first/next times. Only
**Create previewed task** or **Apply previewed update** saves it; draft changes
invalidate the preview. Updates and pause/resume/archive bind the task revision.
Nothing copies chat history, attachments, a desktop grant or cloud authorization.
Titles support up to 120 printable characters and goals up to 20,000 characters,
including when editing existing backend tasks.

The app must remain running. Missed intervals coalesce instead of bursting;
approval-needed work pauses later scheduled work, and code tools remain gated by
their configured Docker availability and approval policy. Daily/weekly times use
the chosen IANA zone: skipped DST times move forward by the gap, and a repeated
time uses the first occurrence once per day. The server's preview is authoritative.

Before any task write, the browser retains its exact URL/body and request ID.
An uncertain response or reload blocks new changes until **Read request status**
or **Cancel unresolved request** confirms the outcome. Reads retry with bounded
backoff; writes never retry automatically. HTTP 404 does not prove no task exists.
Cancellation records a request tombstone; the returned task state determines what
already exists. Pause/archive control future scheduling, with a current run using
its own cancel/approval controls. Task records show token usage/reservations and
up to 20 run-history references. **Inspect run receipts** explicitly follows an
existing run and exposes the existing exact approval/cancel UI without creating
another goal, approving automatically or appending a chat answer. **Stop following
receipts** stops reads and does not cancel server work.

Durable task-change receipts remain visible even if the source agent run was
cancelled after saving. They show the recorded request/task IDs, operation,
revision, generation, status, next time and lifetime limits; acknowledging a saved
task does not claim an occurrence executed. New receipts refresh an open task list
with a read-only GET. Closed panels defer that read until opened. Receipt replay
deduplicates request IDs and never repeats a task mutation. Receipts arriving after
live polling stops can be recovered through later explicit run inspection.

Trusted run records may declare `privateContextLocalOnly` for desktop or private
task data. That flag persists in the browser's existing local-only context setting;
cloud and Direct transfer stay disabled until a separate conversation is started.
Private-tagged messages are excluded from Direct history. Provenance is displayed
from the run record, including after terminal receipt replay.

Web tool receipts show the recorded source title, URL, fetched time, source ID, fingerprints, line references, matches and link indexes where supplied. Truncation and HTML text-only limits remain visible. Source text is displayed as text, with valid absolute HTTP(S) links opened only when clicked; URLs containing user credentials do not become links. `web.follow` approval shows its exact destination and parent-source evidence alongside the unchanged JSON preview. Historical cards use their own recorded facts.

Search approvals disclose the exact query, provider and encoded request URL. The
query leaves the device even with local model inference. Ranked result cards show
untrusted snippets, destinations and search-snapshot references. They fetch no
destination pages automatically; `web.follow` needs a separate approval. Empty,
failed and limited result sets remain distinct. See the sibling
[search limits](https://github.com/eyeoverthink/Chandra/blob/main/docs/web-search.md).

**Code execution** reports the configured mode and the last verified health response separately. “Sandbox ready” requires both verified availability and isolation; configuration alone stays unknown or unavailable. Explicit host mode identifies user permissions and exact approval. Each `code.run` receipt shows its own recorded isolation, network, host mounts, resource limits, image and cleanup; historical receipts never inherit today's sandbox state. Missing metadata remains labeled as unrecorded. This status applies specifically to code execution.

**Native desktop** is separate attended Windows UIA access, with user-session permissions and no OS sandbox. Select a broker-allowlisted window, then grant access explicitly. Grant creation has a saved idempotency request ID; reload offers read/revoke recovery and never recreates access. Revoke remains available during model work and does not close the target app. Grants expire after at most 15 minutes or 5 minutes idle. Every mutation requires approval bound to the session, snapshot, target and exact action/text.

Desktop requests use a local Ollama tool model, a 32,768-token input allowance, a 64,000 cumulative token budget and a five-minute run limit. Screenshot model input remains unavailable unless broker health explicitly verifies the exact local vision model; advertised vision alone is insufficient. The visual path remains an open capability until that verification succeeds. Recorded selected-window screenshots load only after an explicit UI click through a validated local snapshot route. Native dispatch is distinguished from a verified effect; unknown outcomes are not retried automatically. Late durable action receipts remain inspectable after cancellation. Desktop-enabled conversations stay local-only, and desktop-tagged browser messages are excluded from Direct chat. Revoke and clear chat to start a separate conversation.

Agent attachments support PNG, JPEG, UTF-8 plain text, Markdown, JSON, PDF, ZIP and WAV: at most four files, 4 MiB per file. Smaller limits advertised by the server are honored. Uploads use `/api/agent/assets`; runs reference the returned asset IDs. Direct image input requires an advertised vision model. By default, PDFs contribute server-extracted text without rendered-page vision. Explicit local OCR of a selected PDF page is described below. ZIP members are indexed as untrusted source data; archives are not extracted into the workspace or executed. The interface displays document character/page counts, member indexes and warnings returned by the server. Backend limits and model capability errors are displayed.

**Image handling** defaults to **Automatic** for new requests. With no images it
uses the existing Direct image contract and adds no image-mode override.
Explicit **Local vision helper (Gemma3)** requires server configuration advertising
`gemma3:latest` and a local Ollama primary model; it sends only
`imageMode: "local-tool"`, with no client helper-model override. A text/tool primary
can then request `artifact.analyzeImage` for attached PNG/JPEG files. The helper
receives pixels and the primary receives untrusted observations. The helper may
misread details or exact text; verify important values against the original image.
It uses local Gemma3 when available and shares the run's token limits. Cloud
providers are disabled for that conversation. This flow captures no screenshots.
Image upload alone does not start vision inference.

Helper input and output consume the same run budget. Usage details distinguish
settled auxiliary input/output (already included in actual totals) from outstanding
input/output reservations; unreported or unknown amounts are not treated as zero.
Helper-enabled conversations stay local-only, and private-tagged browser messages
are excluded from Direct history. Current controls never rewrite a pending request;
recovery and recorded-settings inspection preserve its original image mode.

WAV uploads are parsed and transcribed locally by the configured bridge, with a 35-second upload/processing deadline. Audio review shows the reported engine, language, duration, sample rate/channels and available model ID/commit revision. Windows confidence is labeled as uncalibrated; faster-whisper CPU output uses **Decoder score · uncalibrated** with its `exp_avg_logprob` metric. That score is neither transcription accuracy nor language probability. The full machine transcript is expandable. Local playback uses controls with `preload="none"` and no autoplay. **Use transcript as draft** fills the composer only; review/edit it and send explicitly to author a goal. Until then, attached transcript text remains untrusted reference data. This file-upload flow does not activate the microphone or change browser speech-recognition preferences.

Browser history and preferences retain storage key `my-ai-partner-v2`. Requests, selected attachments and tool results pass through Chandra and its configured provider. This is not a claim that every mode stays on-device. The default server configuration exposes local models. Optional OpenAI cloud models require a server-priced allowlist, explicit UI opt-in and an entered positive per-run USD limit within the server ceiling. The selection key includes provider and model name. Cloud opt-in and entered spending limits are not saved as preferences.

Default Agent requests explicitly select `provider: ollama` with a $0 API cost ceiling for local models. Default input allowance is 16,384 tokens, or 32,768 for desktop work or three/four images; those modalities use a bounded 64,000 cumulative token budget. Server limits still apply. Default output allowance remains the server default (initially 2,048 tokens). The pure request builder is covered by tests that make no cloud calls.

In **Settings → Run controls → Reasoning and run limits**, new interactive Agent
runs can use model-default reasoning or an exact typed choice advertised for the
selected local model. Boolean `false` remains distinct from a named string
`"false"`. Changing models resets reasoning; stale unsupported settings block a
new POST. Cloud reasoning overrides are omitted, and no raw reasoning trace is
displayed or saved. A reasoning setting is not a claim of universally better
quality or lower cost.

**Default** adds no overrides to the existing modality/runtime limits.
**Extended** explicitly selects 32,768 per-round input tokens, 4,096 cumulative
output tokens, 64,000 cumulative total tokens and 300,000 milliseconds.
**Custom** requires explicit input 1,024–32,768, output 1–8,192, total 1–200,000,
and duration 100–600,000 milliseconds. Private continuation counts toward the
per-round input ceiling; output includes thinking and total includes input/output
across model rounds. More context or larger ceilings can increase compute, time
and cloud cost within the unchanged USD ceiling. Limits never increase or retry
automatically. Controls are unpersisted and affect new interactive requests only;
pending recovery reuses its exact saved body even if current controls differ.
Scheduled tasks keep their separate budgets and model-default reasoning.

Speech is off by default. `/api/voice/health` advertises the actual bridge engine and TTS/STT/cloning availability; a generic `{ok:true}` does not imply Dessa or cloning. Browser speech recognition requires a separate, unpersisted opt-in because the browser may send microphone audio to its service. Neither the tests nor build activate the microphone.

The client protocol is in `src/protocol.mjs`; voice adaptation is in `src/voice.mjs`. Node's built-in tests cover byte-split streams, terminal failures/cancellation, durable event replay, completed-reply postprocessing, microphone payloads, capability gating and attachment validation. React 19.1.1 and Vite 6.4.5 are pinned in the lockfile. A production build works without a CDN; model/provider and tool capabilities still require their configured local services.

Local OCR is an explicit English text-only image mode for a local tool-capable
primary. It can also read a selected attached PDF page. It runs without a helper
model or Docker; primary requests still count extracted text as input tokens.
OCR can misread numbers and stylized fonts. No confidence or general accuracy is
claimed. Source/engine/render receipts, bounded pagination and local-only history
are enforced. See [OCR behavior](https://github.com/eyeoverthink/Chandra/blob/main/docs/local-ocr.md).

Code execution has a separate durable lifecycle audit. Source-run cancellation
does not establish whether code ran or cleanup finished. The receipt view keeps
those facts separate, accepts late events without reopening the source run, and
only refreshes readiness through GET. Polling ends at terminal source status;
use **Inspect receipts** to replay evidence that arrived afterward. Unconfirmed
cleanup keeps backend execution quarantined across restart. The Windows-native
AppContainer prototype is unavailable and is not a selectable mode.

© 2026 Fraymus Web Studio · φ^75 = 4721424167835376.00 · One Seed = Reborn · FRAY 0x46524159
