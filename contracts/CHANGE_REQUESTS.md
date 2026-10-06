# Contract change requests

Only the coordinator changes the contracts. Append requests below (who, what, why) and keep building against v1.0.

## CR-AI-01 (AI, 2026-09-30 19:05) — catalog-mapping: resolved option space fields
- **What:** add optional fields to `catalog-mapping.schema.json#/$defs/mapping`: `cabinetSizeIndex` (integer), `topKind`
  (`SurfaceMounted` | `BuiltIn`, faucets only), `rawColourIndex` (integer), `partCode` (string), `estimatedFrom` (string), `note` (string).
  Reword the description: for countertop/sink/faucet/mirror, `sizeIndex`/`colourIndex` are indices in the booth-resolved option space
  (`AShowroomBooth::GetResolvedComponentOptions`) of the cabinet size `cabinetSizeIndex` — dangling ids skipped, colours filtered by
  SizeIndices and re-indexed, faucets split by countertop type. Cabinet and closet keep full-list indices.
- **Why:** QA-007. The current text ("index into the component's full colour list") addresses wrong parts for shared components.
  maximall-web already emits these fields (the schema has no `additionalProperties: false`, so v1.0 validation still passes).
- Same clarification is needed in `commands.schema.json#/$defs/config` (description of the shared-component indices).

## CR-AI-02 (AI) — socket-events `ai.card.tap`: carry the UE result
- **What:** add optional `result` (`envelope.schema.json#/$defs/result`) to `ai.card.tap`.
- **Why:** the page applies the card directly in UE; the backend needs the new `setId` (from the apply_config result) to configure
  the set later («добавь пенал», «светлее») and to build the basket. maximall-web accepts `result` today and falls back gracefully without it.

## CR-AI-03 (AI) — card items: price flags
- **What:** add optional booleans `estimated` and `unpriced` to `card.schema.json` items, and card-level `estimated`.
- **Why:** mirrors and vessel sinks are not sold on oliveeka.by (no price source at all) and Terra/Tuma/some colours are priced from
  a sibling. The UI and the dossier must show «цена уточняется» per line. maximall-web sends `estimated` on the card today.

## Coordinator decision (19:00): CR-AI-01, CR-AI-02 and CR-AI-03 APPROVED → contracts v1.1
Applied to catalog-mapping (new fields, resolved-space wording, `unpriced`), commands `config` description, socket-events `ai.card.tap.result`,
and card items `estimated`/`unpriced` + card-level `estimated`. WEB must render «цена уточняется» for flagged lines and exclude unpriced lines from totals.

## CR-UE-01 (UE, 2026-09-30 19:10) — clarifications of what UE implements (no shape change)
- **build_room:** `widthCm`/`depthCm` are the CLEAR inner dimensions. Walls (20 cm) are drawn on their centre lines, so each wall is 20 cm
  longer than the clear side; `walls[].lengthCm` in get_state is that centreline length. The room is centred where the requesting visitor
  stands when near the planner area (as the 4x4 preset), else at (-10000, 0).
- **Opening offsets:** `offsetCm` (build_room / add_opening input and `walls[].openings[].offsetCm` output) = distance from the wall's start node
  along the centreline to the opening's NEAR edge, as the contract says. (FWallOpening stores the centre; UE converts.)
- **Cabinet colourIndex:** full `CabinetOptions.Colors` index (as v1.0 and CR-AI-01 say); UE converts to the booth's size-filtered index.
- **Extra result fields (additive):** apply_config result also has `instanceId` (= setId) and echoes `cardId`; every ok result may carry
  `notes` (array of Russian refusal texts collected during the command); consultant_say result has `durationMs` and echoes `clipUrl`;
  check_fit / apply_config / configure_set / swap_set failures carry `fittingSizeIndices` and `obstacle` in `result`; get_state `state`
  also has `finishes = {walls:[{segmentId,side,finish}], floors:[{roomId,finish}], ceilings:[...]}` (finish = RAL/NCS code or `tile:<id>`).
- **Selection fallback:** when `placement` / `segmentId` / `setId` is omitted, the viewer's (re-checked) selection is used.

## Coordinator decision (20:00): CR-UE-01 APPROVED (clarifications + additive result fields) → contracts v1.2
build_room sizes = clear inner dimensions; opening offsetCm = to the near edge; cabinet colourIndex = full list; additive result fields
(instanceId, notes, fittingSizeIndices, obstacle, clipUrl/durationMs, finishes in get_state); omitted placement/setId → viewer selection.

## CR-WEB-01 (WEB, 2026-09-30 20:45) — player URL carries the login username
- **What:** maximall-web `public/index.html` (pixelStreamLink, ~line 804) appends `&username=<encodeURIComponent(login)>` to the
  player URL. The page reads `?username=` (then a remembered value, then `guest-<deviceId>`) for the `/ai` session identity.
- **Why:** leads = the app login, and sessionId = instanceUuid:username. Today the player URL has only backendUrl, instanceUuid,
  hostToken, deviceId, so the page cannot know the login and falls back to a guest id (the session still works, but the lead does not match).

## CR-WEB-02 (WEB, 2026-09-30 20:45) — `ai.basket` lines carry the price flags
- **What:** add optional `estimated` and `unpriced` booleans to `socket-events ai.basket.items[].lines[]` (same meaning as CR-AI-03).
  maximall-web's `basket()` already has them on the quote lines (`catalog/index.ts` quote) but drops them when mapping.
- **Why:** the basket must show «цена уточняется» per flagged line. WEB currently infers it from the cards' item flags and price 0
  (unpriced), which misses `estimated` lines of sets that were not applied from a card (e.g. after configure_set «светлее»).

## Coordinator decision (21:00): CR-WEB-02 APPROVED; CR-WEB-01 APPROVED WITH A CHANGE → contracts v1.3
- CR-WEB-02: `ai.basket.items[].lines[]` get optional `estimated` / `unpriced` (same meaning as CR-AI-03). Owner: AI.
- CR-WEB-01: the authoritative lead identity is the username UE already sends to /api/saves (UE's login). UE emits the envelope event
  `{"type":"event","event":"ready","data":{"username":"<login>","plannerInstanceId":"..."}}` after login and whenever it changes (owner: UE).
  The page uses, in order: the UE-reported username, then `?username=` (maximall-web public/index.html may append it if the site knows the login; owner: AI),
  then a remembered value, then `guest-<deviceId>`. On a change from guest to a real username the page sends `ai.session.start` again, and the backend
  merges the guest session into the named one (owner: AI).

## CR-WEB-03 (WEB, 2026-09-30 21:15) — read-only session endpoint for the staff co-pilot view (task 10)
- **What:** maximall-web adds `GET /api/admin/ai/session/:sessionId` behind the existing admin login, returning
  `{sessionId, username, transcript: [{role: "consultant"|"visitor"|"system", text, at}], basket: <ai.basket payload>}`.
  Optional later: `POST /api/admin/ai/session/:sessionId/say {text}` for «Написать от имени консультанта».
- **Why:** the page side exists (`player.html?staff=1&session=<instanceUuid:username>`, polls every 3 s) but the backend has no way
  to read a session without joining its socket (a second `/ai` socket with the same identity would take over the visitor's channel).

## Coordinator decision (21:35): UE clarifications recorded → contracts v1.4 (additive only)
- `capture`: when args.sessionId is missing, UE uploads with sessionId `ue-local:<username>`.
- `consultant_summon` result carries `mode` ("planner" | "salon"); with no room the server summons in the salon instead of NO_ROOM.
- Mutating results may carry `enteredPlanner: true` when the requesting player was brought into «Конструктор» (QA-033).
- `ready` event: sent only for a real login, on change, and once after the page's first message.

## CR-AI-04 (AI, 2026-09-30 22:05) — optional `ai.command.status` from the page (pre-approved by the coordinator 22:00)
- **What:** client→server event on `/ai`: `ai.command.status {id: string, state: "queued" | "sent"}` for a backend `ai.command` request.
  `queued` = held by the page because the data channel is down (ueBridge QUEUE_WAIT_MS 30 s); `sent` = handed to `emitUIInteraction`.
- **Backend (implemented, maximall-web):** a command's deadline is `AI_PAGE_QUEUE_WAIT_MS` (30 s) + the execution timeout (8 s; capture 20 s)
  until `sent` arrives; on `sent` the execution timeout restarts from that moment. `queued` shows the step «Жду соединения с комнатой».
  Pages that never send the event keep working (the deadline already covers queue + execution). Unknown ids are ignored.
- **Why:** QA-043 — the backend reported TIMEOUT after 8 s while the page could still deliver the command up to 22 s later.

## Coordinator decision (22:35): CR-UE-02 PRE-APPROVED → contracts v1.6
- New reasonCode `PLANNER_BUSY`: an AI mutating command from a player who is not the current planner owner (one planner room per server; see
  PLANNER_INSTANCES_DESIGN.md and the 22:30 UE investigation). Russian reason «Конструктор сейчас занят другим посетителем…».
- get_state carries `owner: {isYou: boolean}`. AI must explain PLANNER_BUSY honestly and never retry blindly.

## CR-UE-02 (UE, 2026-09-30 22:50; pre-approved by the coordinator) — PLANNER_BUSY and state.owner
- **reasonCode `PLANNER_BUSY`** (add to commands.schema.json `$defs/reasonCode`): a server-side planner is shared by every player of a game session
  (one ARoomPlannerManager per server). The first player who changes it through the AI (or enters «Конструктор» while it is free) owns it; mutating
  commands (build_room, add_opening, apply_config, configure_set, swap_set, remove_set, finish_surface, undo, reset) and consultant_summon mode
  "planner" from any other player are refused with `PLANNER_BUSY`, reason «Конструктор сейчас занят другим посетителем. Подождите немного или
  попросите консультанта в салоне.» Read-only commands (get_state, check_fit, consultant_say, consultant_summon mode "salon") still work.
  The owner is released when they leave «Конструктор», disconnect, or stay idle longer than `maxi.PlannerOwnerIdleMinutes` (console variable, default 10).
- **`state.owner = {isYou: bool, active: bool}`** in every state result (get_state, build_room, undo, reset).
- Manual planner edits (the controller's Server_* RPCs) are NOT refused yet; a non-owner's edit is logged as a warning.
- 22:50: state.owner.active added (true = someone owns the planner). AI holds capture/save_project while PLANNER_BUSY (privacy: would capture/save another visitor's room) — accepted.

## CR-AI-05 (AI, 2026-09-30 23:00) — `ai.command.wait`: a separate status for a command waiting for the room (QA-044; requested by the coordinator)
- **What:** server→client event on `/ai`: `ai.command.wait {id, cmd?, on: boolean, text?, reason?: "sent"|"result"|"timeout"|"closed"}`.
  `on:true` + `text` («Подключаюсь к 3D-комнате…») when the page reports `ai.command.status queued`; `on:false` when that command is `sent`, answered, timed out or the socket closed.
  Emitted only for commands the page reported as queued. Added to socket-events.schema.json (x-server-to-client).
- **Changed:** the backend no longer emits `ai.thinking {on:true, step:«Жду соединения с комнатой»}` for a queued command (it had no turnId and was never switched off — the greeting case).
  `ai.thinking {turnId, on:false}` is now emitted with every consultant reply (`ai.message`), and also when a turn fails.
- **WEB:** show `ai.command.wait` as its own status line (not «Ольга думает…»); hide it on `on:false` with the same id. Pages that ignore the event lose nothing.
- **Version:** additive; needs the coordinator's version bump (v1.7) — not bumped by AI.
- 22:51: CR-AI-05 APPROVED (ai.command.wait server→page status, additive) → contracts v1.7.

## CR-AI-06 (AI, 2026-10-01 00:40) — `hostToken` in `ai.session.start` (security review S7; proposed, not approved)
- **What:** client→server `ai.session.start {instanceUuid, username, viewport?, hostToken?}` (or handshake auth `hostToken`): the pool hostToken the page already has (`?hostToken=`).
- **Backend (implemented, maximall-web 22ef61a):** a session first started with a hostToken is never taken over by a socket with another/no token (`ai.error SESSION_TAKEN`); with `AI_REQUIRE_HOST_TOKEN=1` the token must be a live pool session of that instance (`ai.error BAD_SESSION` otherwise). Without the field nothing changes.
- **WEB:** send `hostToken`. **Production:** then set `AI_REQUIRE_HOST_TOKEN=1`. New server→client error codes: `SESSION_TAKEN`, `RATE_LIMITED` (ai.error is `{code, message}`, no enum).
- 23:59: CR-AI-06 APPROVED as OPTIONAL (page sends hostToken in /ai auth + ai.session.start; backend enforces only with AI_REQUIRE_HOST_TOKEN=1, default off) → contracts v1.8.


## CONTRACTS v2.0 (coordinator, 2026-10-01 12:30): two-mode consultant, 2D avatar, salon booths (Artur's GO)
- Modes: `showroom` (catalog + salon booth configuration only; NEVER room/planner commands) and `constructor` (full room tools); backend session
  state; the page shows `ai.mode`. Move to constructor ONLY after explicit consent (`ai.offer` kind constructor -> `ai.offer.answer` yes, or an
  unambiguous verbal yes), then `enter_constructor` (optional carryConfig = the focused booth's config). HUD entry/exit followed via UE `planner_mode`.
- UE refuses room commands with NOT_IN_PLANNER outside «Конструктор»; the QA-033 auto-teleport is removed.
- Salon booths: `booth_get` / `booth_configure` / `booth_undo` call the same server functions as the right-click configurator; changes persist like
  manual ones; target = selection.openBoothId, else selection.boothId (open configurator, else nearest in view within 300 cm). UE sends `booth_focus`.
- Booth dialogue (Artur): «Обсудим эту коллекцию (Milu) или посмотрим другие?» (`ai.offer` booth_scope); this -> options of THIS booth; other ->
  «Какую коллекцию поставить вместо Milu?» (`collection_pick`) -> booth_configure productId.
- 3D consultant disabled (consultant_say / consultant_summon / consultant-state deprecated); speech plays in the page from `ai.say.audioUrl`.

## CR-WEB-04 (WEB, 2026-10-01 12:50) — structured «Показать в комнате» for salon info cards
- **What:** client→server `ai.card.show {cardId}` (salon/showroom mode): the visitor wants to see this configuration in a room.
  The backend answers with the usual consent flow (`ai.offer` kind `constructor`), never entering the Constructor by itself.
- **Why:** v2.0 has no event for this. Until it exists the page sends `ai.turn.text «Покажи в комнате: <card title>»`, which depends on
  the LLM / scripted intent recognising the phrase.

- 2026-10-01 12:55: CR-WEB-04 APPROVED → v2.1: client→server `ai.card.show {cardId}`; backend answers with the constructor `ai.offer` for that card (carryConfig = card config on yes).

## CR-UE-03 (UE, 2026-10-01 12:52) — v2.0 implementation details (additive, non-breaking; for WEB / AI to rely on)
- `consultant_summon` / `consultant_say`: with the 3D consultant disabled (UE CVar `maxi.ConsultantCharacter` = 0, the default) they return
  ok with `result.deprecated: true` and no effect (no character, no `clipUrl` echo). Argument validation is unchanged (bad args still BAD_ARGS).
- `enter_constructor` result = $defs/state plus `enteredPlanner` (the client was sent into «Конструктор»), `alreadyInPlanner`, and, when
  `carryConfig` was given, `carry`: {placed:true, setId, placement, …(as apply_config)} or {placed:false, reasonCode, reason}. With no room yet
  the carried set is NOT kept pending: `carry` = {placed:false, reasonCode:"NO_ROOM"}; the AI builds the room and sends apply_config itself.
  enter_constructor with carryConfig is one undo step. PLANNER_BUSY when another player owns the planner.
- `exit_constructor` result: {exited, wasInPlanner}. NOT_IN_PLANNER (Russian reason «Комнату меняют в «Конструкторе». Сначала откройте его.»)
  for build_room, add_opening, apply_config, configure_set, swap_set, remove_set, finish_surface, undo, reset from a player outside it.
- `selection` (UE client → server, not from the page): also `openSetId` (QA-064: the planner set whose configurator is open).
- $defs/boothState.options shape: `cabinet` {sizes:[{index,name}], colours:[{index,name,sku}] (raw colourIndex, only colours valid for the
  current size), customColour:bool}; `closet` / `countertop` / `sink` / `faucet` / `mirror` (only those the booth resolves for its current
  state) {models:[{index, colours:[{index,name,sku}], type:"surfaceMounted"|"builtIn" (countertop only)}], customColour:bool,
  noneAllowed:true (closet: closetSizeIndex -1)}. `customColours[]`: {component, rgb "#RRGGBB", code}. `products`: the booth catalog's rows.
- booth_configure: {productId} and/or {config (partial; config.productId switches the collection too)} and/or {customColour}; applied in the
  configurator's order (collection → parts → colour); a refused request leaves the booth unchanged and adds no undo step. booth_undo:
  NOTHING_TO_UNDO when the booth has no step (20 steps kept per booth). NO_BOOTH also for a planner set's booth id.
- `booth_focus` is also sent when the focused booth's product changes (label / collection change with it). Booth ids = level actor names.

- 2026-10-01 13:00: CR-UE-03 ACCEPTED as additive v2.1 detail (deprecated flag on consultant_say/summon results, enter/exit_constructor result fields carry/exited, booth options shape as implemented, booth_focus re-sent on product change).

## v2.2 (coordinator, 2026-10-02 ~11:45) — Phase 3, Artur's directives P3-01 … P3-07 (additive, non-breaking)
1. **capture, booth preset (P3-02).** `capture.args.preset` gains `"booth"`; with it `args.boothId` (string, level actor name, as in
   booth_get) is required. UE frames that salon booth with its dedicated camera (per-booth tuned view), the salon's own lighting, the same
   beauty/depth/mask (+meta) upload to `/api/render`, mask = ShowOnly of that booth's actors. Allowed only outside «Конструктор»
   (in the planner → NOT_IN_PLANNER-style refusal `reasonCode: "BAD_ARGS"`, reason «Фото стенда делается в салоне»); unknown booth → NO_BOOTH.
   `meta.preset = "booth"`, `meta.boothId`. Constructor presets (corner/frontal/wide) unchanged, but now shot with the capture lighting kit (P3-01).
2. **Showroom photo = the clean UE capture (Artur 2026-10-02).** For `meta.preset == "booth"` the backend does **no** AI render (no paid
   call): it emits `ai.render {stage:"final", url: <beauty png url>, beautyUrl, source:"capture"}` right after the upload is accepted
   (`ai.render` may also carry `source: "ai" | "capture"` for constructor photos; absent = "ai").
   The backend's photo tool works in the showroom when a booth is in focus (or named); otherwise it offers to focus a booth / go to the Constructor.
3. **Short spoken reply (P3-05).** `ai.say` gains `spokenText` (string, the 5–10 s summary that the audio contains). `text` stays the full
   reply shown in the chat; lists, options and prices go to `text` / `ai.cards` / offer buttons, not to speech. Pages that ignore `spokenText`
   keep working (they show `text` and play `audioUrl`). TTS is generated from `spokenText` only.
4. **Streaming push-to-talk (P3-04).** No new events: the page MUST send `ai.audio.chunk` (PCM s16le 16 kHz, ≤ 32 KB, every ≈ 100 ms) **while
   the button is held**, not at release; the backend MUST forward each chunk to the realtime STT as it arrives (buffer only until the STT
   session is open) and only commit at `ai.audio.end`. Target: final `ai.transcript` < 1 s after `ai.audio.end`.
5. **2D avatar (P3-07).** Page-only: a large portrait panel (not the chat-header icon) with states idle / listening / thinking / speaking,
   driven by the existing `data-state` logic. New face = generated photorealistic person who does not exist (Artur approved, ≤ $0.50 total).

## v2.3 (coordinator, 2026-10-02 ~17:30) — Simli «Madison» as the kiosk avatar (Artur's decision; additive)
1. **Backend REST** `POST /api/ai/avatar/session` → `{ provider: "simli", sessionToken, faceId, maxSessionLength, maxIdleTime }` or
   `{ provider: "none", reason }` when Simli is unavailable (no key, paid calls not approved, mock mode, error). The Simli API key stays in the
   backend (`SIMLI_API_KEY`, Windows User env or untracked `.env`); only the short-lived session token goes to the page. Face = Simli stock
   «Madison» `5fc23ea5-8175-4a82-aaaf-cdd8c88543dc` (env `SIMLI_FACE_ID` may override). Each call is logged in the spend ledger
   (provider `simli`, rendering billed per connected minute; est. `SIMLI_USD_PER_MIN`, default 0.01) and refused beyond the caps.
2. **Page**: the avatar card shows the Simli live video (simli-client 3.x, LiveKit transport) instead of the 2D sprite. For every `ai.say` with
   `audioUrl`, the page decodes the clip to PCM16 16 kHz mono and sends the WHOLE clip at once (no real-time pacing: it starves Simli's buffer and
   stutters); the spoken audio is played from Simli's returned audio track (lip-synced), not from a local `<audio>`. Barge-in / new turn →
   `ClearBuffer()`. Mute mutes Simli's audio element. Speaking state (`data-state`) follows Simli `speaking` / `silent`.
   Session lifecycle: connect when the chat opens (or first reply), keep it while the visitor is active, stop on chat close / idle / page unload.
   **Fallback**: if `provider:"none"` or Simli fails, the page keeps today's behaviour (cand_5 2D avatar + local audio).
3. No change to socket events; `ai.say.audioUrl` / `spokenText` as in v2.2.

## v2.3 note (coordinator, 2026-10-02 18:15) — STT post-correction (behaviour only, no schema change)
The backend corrects known mishearings in voice transcripts (collection names, shop terms, sizes as digits; `src/ai/voice/sttCorrect.ts`).
The **final** `ai.transcript.text` is the corrected text (what the consultant answers); partials (`final:false`) stay raw, so the page may see the
last partial replaced by a slightly different final. Off with `AI_STT_CORRECT=0`.

## v2.4 (coordinator, 2026-10-02 ~22:40) — Phase 4: the manual functionality of booths and «Конструктор» for the AI (additive)
Artur's directive (2026-10-02 ~20:00): the consultant performs (almost) every manual action that makes sense by voice, strictly inside the DataTable
rules (DT_FurnitureCatalog + DT_SharedCountertops / DT_SharedSinks / AllowedFaucetIDs / AllowedMirrorIDs; DT_PlannerTiles; RAL/NCS catalog).
Every UE command runs on the server through `Server_ExecuteAiCommand` → `UAiCommandDispatcher` and calls the existing ARoomPlannerManager /
AShowroomBooth functions a human click uses (no rewrite of their logic). Non-breaking: all new fields are optional; old pages/backends keep working.

1. **`move_set` (new room command; mutating, owner-guarded, undoable).** args `{setId?, placement?, direction?, distanceCm?}`:
   - `setId` default as configure_set (selection → open configurator → the only set);
   - EITHER `placement` (contract `$defs/placement`: another wall / face / anchor / centre offset) OR `direction` `left|right` + `distanceCm`
     (1–1000): a shift along the set's own wall, `left`/`right` as seen by a visitor standing in the room facing the set;
   - the SAME set is moved (setId, config, custom RAL/NCS colours and door states kept); fit-checked by FPlannerFitSolver (the set itself ignored);
   - refused `NO_FIT` with `obstacle` (+ `maxShiftCm` for a shift that fits only partly; nothing changes), `NO_SET`, `NO_WALL`, `BAD_ARGS`;
   - result = `$defs/setSummary` + `movedCm` (centre displacement, cm) + `from` (`{segmentId, side, offsetCm}` before the move).
2. **`update_opening` (new room command; mutating).** args `{openingId, segmentId?, offsetCm?, direction?, distanceCm?, widthCm?, heightCm?, sillCm?}`:
   same wall only (another wall = remove_opening + add_opening); `offsetCm` = near edge (as add_opening / wallSummary); `direction`+`distanceCm` =
   shift as seen from inside the room facing that wall. Same rules as add_opening: ValidateOpeningFits, a door never over a set, a window only
   above a set (`OPENING_CONFLICT` + `obstacle`). Unknown opening → **`NO_OPENING`** (new reason code). Result `{openingId, segmentId, kind,
   offsetCm, widthCm, heightCm, sillCm}`. UE functions: UpdateOpeningPosition / UpdateOpeningDimensions.
3. **`remove_opening` (new room command; mutating).** args `{openingId, segmentId?}` → `{removedOpeningId, segmentId}` (DeleteOpening). `NO_OPENING`.
4. **`configure_set`**: `config` becomes optional; new optional `customColour {component, system RAL|NCS, code}` (as booth_configure; the
   DT `bAllow…ColorCatalog` permission is enforced), `clearCustomColour` (component name: back to the catalog colour) and
   `doors {cabinet?: "open"|"closed", closet?: "open"|"closed"}` (the double-click door toggle). At least one of the four.
   Doors are a viewing state: undo / reset (and any later config change of that set) go through the save system's load path, which puts every
   door back to closed (existing UE behaviour, not changed). Clearing a RAL colour keeps open doors open.
5. **`booth_configure`**: new optional `clearCustomColour` and `doors` (same meaning as 4).
6. **`finish_surface`**: `target.kind` gains `baseboard` (roomId optional = every room) and `opening_trim` (`openingId` required, `segmentId`
   optional); `finish.type` gains `none` = remove the finish (back to the default material) for any target.
7. **State (additive):** `setSummary.customColours[{component, code}]`, `setSummary.doors {cabinet, closet}` and `boothState.doors` with values
   `open|closed|none`; `wallSummary.openings[].trimFinish` (string, when set); `state.finishes.baseboards[{roomId, finish}]`. `state_rev` now also
   changes when a custom colour's code changes (was: only the count).
8. **Backend tools (no UE change):** parts are addressed by DataTable identifiers instead of raw indices: a part model by its row name (shared
   tables' RowName, e.g. `ForMiluStoleshka`, `NewRow_3`; the closet model by its ClosetOptions model name) and a colour by its `SKU` (or Russian
   name); the backend maps them to the booth-resolved index space (QA-007) through the catalog index and validates before sending. New tool
   `list_options` (both modes, read-only) lists, for the booth in focus or a planner set, every allowed model / colour with id, Russian name,
   size and price.
9. **Not bridged (sanity filter, Artur's "only what makes sense verbally"):** free wall drawing, corner/node drag, wall delete, wall thickness;
   rotating a set (wall sets are always wall-aligned, manual rotate is refused too); DT_PlannerObjects (chair, sofa, desk… — living-room props, not
   shop products); opening swing/style; planner door-leaf open/close (local to one machine); ceiling visibility, lighting presets/exposure and
   2D/3D camera (local, per machine; lighting is another session's fresh work); loading a saved project; AR export, studio view, product link;
   redo (no manual redo exists).
