# Contracts v2.4 (2026-10-02 Phase 4: the manual functionality for the AI — move_set, update_opening / remove_opening, set & booth doors and colours, baseboard / trim / clear finishes, parts by DataTable id); v2.3 (Simli avatar); v2.2 (2026-10-02 Phase 3: booth capture preset, showroom photo = UE capture, ai.say.spokenText, streaming PTT, large avatar); v2.1 (12:55 CR-WEB-04 ai.card.show); v2.0 (2026-10-01 12:30: two modes, salon booths, 2D avatar; see CHANGE_REQUESTS.md)

Every role builds against these files. Only the coordinator changes them. To request a change, write it in
`docs/AI_Consultant_Expo/contracts/CHANGE_REQUESTS.md` (who, what, why) and continue with the current version.
All user-facing strings are **Russian**. All money is **BYN**. All lengths are **centimetres** unless the name says otherwise.

| File | Between | Content |
|---|---|---|
| `envelope.schema.json` | Web UI ↔ UE client | `MaxiMallAI` request envelope, result, unsolicited events |
| `commands.schema.json` | Backend/Web UI ↔ UE server dispatcher | The 15 commands, their `args` and `result` shapes, and the reason codes |
| `card.schema.json` | Backend → Web UI | The proposal card (`ai.cards`) |
| `catalog-mapping.schema.json` | Scraper/index ↔ UE catalog | One mapping entry per (ProductID, component, sizeIndex, colourIndex) ↔ article code + price |
| `socket-events.schema.json` | Backend ↔ Web UI (Socket.io, namespace `/ai`) | Event names and payloads |
| `render-api.schema.json` | UE client ↔ Backend | `POST /api/render` multipart (beauty, depth, mask, meta) and the render events |
| `consultant-state.schema.json` | UE C++ ↔ tech artist AnimBP | Replicated consultant state |
| `dossier-api.schema.json` | Web UI/UE ↔ Backend | `POST /api/dossier`, `GET /d/:shortId`, save metrics block |

## Transport summary

```
Browser (player page) ──emitUIInteraction({"type":"MaxiMallAI",...})──▶ UE client (owning PC, OnPixelStreamingInput)
UE client ──Server_ExecuteAiCommand(RequestId, CommandJSON)──▶ GameLift server (UAiCommandDispatcher)
server ──Client_AiCommandResult(RequestId, bOk, Reason, ResultJSON)──▶ UE client
UE client ──SendPixelStreamingResponse("MaxiMallAI:" + resultJSON)──▶ Browser (addResponseEventListener)
Browser ◀──Socket.io /ai──▶ maximall-web orchestrator (LLM, STT, TTS, catalog, render, dossier)
```

The backend never talks to Unreal directly. It sends `ai.command` to the page. The page forwards it to UE and returns
the result with `ai.command.result`. A card tap goes straight from the page to UE (`apply_config`), and the page
then sends `ai.card.tap` with the result. The model is told afterwards.

Client-side commands (`capture`) run on the requesting UE client. All other commands run on the server and
replicate. `consultant_say` audio plays only on the requesting client. The replicated speaking state, subtitle and
gesture are seen by everyone.

## Identity
- `sessionId` = the player's `instanceUuid` (pixel streaming instance) + `:` + `username`. Each visitor has their own session.
- `username` = the app login already sent to `/api/saves`. It is the lead identity.
- Request ids: `r-<epochMs>-<n>`, unique per page.
