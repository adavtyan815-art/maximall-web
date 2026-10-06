# Web Redesign — Phase 1: Desktop splash (`MaxiMall Splash.dc.html`)

Source: `Меню в стиле Apple меню  выбор цвета/handoff/`. **Base layout: `handoff/html/MaxiMall Splash.dc.html`** and `handoff/splash/splash-spec.md`.
The other handoff files (brand spec, configurator, tokens) are context for aesthetics only.
Scope: `public/index.html` on desktop and laptop screens. Mobile is out of scope for this phase.

---

## 1. Layout

The page *is* the splash. A 1000×620 window (radius 18, `#0E0E0E`, 1px white 10 % outline, shadow 0/40/90/−30) sits centered on the `#D9D9D9` canvas used by the dc file. Below it, an info row (copyright, update date from `/api/settings`, social links) takes the place of the dc file's annotation row.

Inside the window everything follows the spec:

| Element | Spec |
|---|---|
| Path `MAXIMALL › САЛОН` | 12 / 600 / 0.30 em; `#8C8C8C`, chevron `#6E6E6E`, `#FFFFFF`; 44 above the salon name |
| `OLIVEEKA` | 64 / 500 / 0.30 em, white |
| Descriptor | 13 / 500 / 0.16 em, caps, `#8C8C8C`, 22 below |
| Door | 1px hairlines at 16 % + radial glow 5.5 %; width `240 + p × 3.4` design px, 120 ms linear |
| Stage label / % · ETA | 13 / 500 `#E6E6E6` ↔ 12 / 400 tabular `#A8A8A8` |
| Bar | 3px, radius 2, track white 14 %, fill white (40 % on error) |
| Footer row | `MaxiMall · Веб` ↔ status, 11px `#6E6E6E` |
| Block position | 56 from the sides, 52 from the bottom |

### Responsive scaling (desktop)

Every size is `N × --u`, where `--u` is one design pixel:

```
--u = min( max(1px, min(100vh/1080, 100vw/1920)),   spec: Shortest Side, base 1080
           100vh/760,                               the whole column must fit the height
           100vw/1048 )                             …and the width
```

- 1080p, 1440×900, 1600×900: window exactly 1000×620 (spec).
- 1440p: about 1.2×. 4K: about 1.9×. 21:9 and 32:9 follow the height, so the window stays centered.
- Small laptops (1280×720, 1366×768): shrink just enough to fit with no scrolling.
- Verified with no scrolling and no overlaps at 1280×600 through 5120×1305.

## 2. Mapping production logic into the splash slots

| State | Stage label slot | Right meta | Footer right | Door / bar |
|---|---|---|---|---|
| `idle` | Lead text, or a notice (another tab, offline, no socket) in white | — | **Войти в 3D-комнату** (light, 38 / r12) or disabled "Ожидайте завершения…" while `stopping` | closed (240), empty |
| `loading` | Stage by threshold: Подключение к MaxiMall → Открываем салон OLIVEEKA → Загружаем сцену и материалы → Подключаем 3D-трансляцию; «Ещё немного — грузим тяжёлые материалы» after 10 s at one cap; connection messages | `NN% · осталось N с` | `Загрузка` + Отменить | opens with progress |
| `ready` | Салон OLIVEEKA готов | `100% · готово` | `Вход` | open (580); 0.6 s hold, 250 ms crossfade, redirect |
| `error` | Error text (white) | `NN%` | Назад + **Повторить** (spec: light button, right, under the bar) | frozen, fill white 40 % |

Usage tips rotate under the descriptor while loading. They are positioned outside the centering, so the title never moves.

Progress model: 120 ms tick. Backend events raise a cap: request 15 → `pending` 41 → `booting_server` 84 → `server-ready` 100. The base rate is 100 %/40 s, with a 0.1 %/s creep at the cap. Progress never moves backwards and resumes after a socket drop. ETA = `ceil((100 − p)/100 × max(40 s, elapsed × 100/p))`.

## 3. Backend contract (unchanged)

Moved from the inline script into `public/assets/app.js` with identical behavior:
`io()`; `deviceId` (localStorage); `assignedUuid` and `global_hostToken` (sessionStorage); emits `request-instance`, `check-active-session`, `resume-instance`, `cancel-request`; handlers `connect`, `connect_error` (8 s), `disconnect` (10 s), `session-found`, `session-in-use`, `session-not-found`, `instance-assigned`, `no-instance-available`, `instance-error`, `instance-status` (stopped / stopping / pending / booting_server), `server-ready`; `?reason=idle`; the player redirect URL (`player.html?backendUrl&instanceUuid&hostToken&deviceId[&ss]`); rescued redirect 3 s.

Fixes made along the way:
1. `reconnect_attempt` is now attached to the Socket.IO Manager. On the socket itself it never fired in v4.
2. `session-not-found` no longer leaves the button locked forever when the socket drops before an instance is assigned.
3. `crypto.randomUUID` has a fallback for non-secure origins. Without it the whole script stopped.

An independent review found no regressions in emits, payloads, storage keys or redirect construction.

## 4. Files

- `public/index.html`: splash markup, no inline script. The Carrd `main.css`/`main.js` are no longer loaded.
- `public/assets/site.css`: splash styles and the `--u` scale system.
- `public/assets/app.js`: socket logic plus the view state machine.
- `public/assets/brand/`: favicons 16/32 and the apple-touch icon from `handoff/brand`.

## 5. Admin and login (same design language)

- `login.html`: a 420px splash window on the `#D9D9D9` canvas with the `MAXIMALL › ПАНЕЛЬ` path, dark inputs and a light «Войти» button. **The `<script>` block is byte-identical to the previous version.** Only the markup text moved to Russian.
- `admin.html`: CSS only. New `:root` tokens (dark window, white hairlines, Instrument Sans, functional status colours), a splash-path brand block, and an override block that turns sidebar and main into one dark window. **The `<script>` block, element ids and inline handlers are byte-identical.**

## 6. Verification performed

| Check | Result |
|---|---|
| Landing, old (`e944774`) vs new, 13 scenarios (normal, rescued, error→retry, busy→retry, stopped with error, clean stop, stopping, another tab, auto-resume, `reason=idle`, cancel, drop mid-boot, drop before assignment) | Socket emits and payloads identical in all 13. Redirect URLs identical. sessionStorage identical. Button state identical except "drop before assignment", where the old page stays locked (bug fixed) |
| Admin, old vs new: stop, delete ×2, abort prewarm, reset time, AWS sync, realign (3+1), save settings | Identical API calls, methods and request bodies. Identical rendering of the stats and tables |
| Login, old vs new | Identical `POST /api/admin/login` body and redirect to `/admin.html` |
| Desktop sizes 1280×600 – 5120×1305 | No scrolling, no overlaps |
| `npm run build` | Passes |

## 7. Next phases

- Mobile layout.
