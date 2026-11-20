# HealthAccess frontend progress

## Status summary
Phase 2 (landing page) is done: dark v2, Murmur-style hero.
Phase 3 is written: `scope.md` and `docs/BUILDER_PROMPT.md`, based on the live API snapshot in `docs/api/`.
**M0 Foundation, M1 lanes and M2 integration are complete on `feat/m0-foundation`.**
Final checks: typecheck, lint, build, 156 unit tests, 164 component tests, 28 mocked e2e tests and the live smoke are green.
Next: reviewer checks step 2, then the branch can be merged.

## Completed
- **Phase 0:** audit approved. Defaults D1–D5 accepted.
- **Phase 1:**
  - Next.js 16.4 (App Router, Cache Components), TypeScript strict, Tailwind 4.
  - `/api/v1` proxied to FastAPI.
  - Security headers, plus `no-store` on sensitive routes.
- **Phase 2 v1:** light layered-SVG landing page (commit `76739ea`). Kept in history and replaced by v2.
- **Phase 2 v2:** dark landing page.
  - **Hero:** blur-in headline and a CSS phone cycling the three journeys, with counter, pause and reduced-motion support.
  - **Feature grid** (bento): the directory card has a canvas wireframe globe.
  - **How it works:** a pinned phone follows the scroll steps.
  - **Channels carousel:** scroll-snap; the voice card is marked "later".
  - **Trust section:** glossy SVG objects, plus a Release 1 scope strip.
  - **Final CTA and footer.**
  - **Preloader:** kept and recoloured.
  - **Verified:**
    - No horizontal overflow at 360, 768, 1280 or 1920 px.
    - Reduced motion: no preloader, all content visible.
    - Without JavaScript: content visible.
    - Keyboard: tab order follows the page (skip link, nav links, then the carousel controls).
    - Headings: in order, h1 → h2 → h3.

- **Phase 3:**
  - `docs/api/healthaccess-api.json` and `docs/api/api-digest.md`: snapshot of the live API docs, 48 endpoints, generated 2026-11-17T18:00Z.
  - `scope.md`: the full build guide.
  - `docs/BUILDER_PROMPT.md`: orchestration prompt for the builder model (M0 lead, six parallel sub-agent lanes, M2 integration, gates).

## In progress
- None.

## Next
- Reviewer: review step 2 against `scope.md` §12.
- Merge `feat/m0-foundation` after review. Note: `origin/main` has newer product work beyond this scoped dashboard branch; a merge may need a rebase.

## M2 integration (2026-11-20)
Completed on `feat/m0-foundation`:
- **Overview cards (§7.2):** each card has its own query, skeleton, error with request id and retry, empty and in-place success. Completeness, emergency status, active grants, last three symptoms and today's doses from the first schedule; doses can be marked taken or missed from the card.
- **Full mocked e2e suite (§8, six journeys):** 28 Playwright tests pass:
  - register → record fields → emergency selection → preview;
  - create grant → receipt → revoke → log shows it;
  - practitioner open → view → revoked → ended;
  - find care → result → detail, plus the empty/wider-radius flow;
  - assistant create → follow-up → cancel;
  - medications manual create → mark taken → progress.
  - Auth, overview, record, care, practitioner, assistant, medications, channels and sharing screens also run axe at 390 and 1440; login and overview run at 390/768/1024/1440. No serious or critical violations.
- **Security sweep:** `npm run security` checks 153 source files for storage, console and raw HTML use; only the landing intro flag and `src/lib/log.ts` are allowed exceptions. Cookies/storage evidence is in `test-results/security/evidence.png`; the grep output is in `test-results/security/grep.txt`.
- **Performance:** `npm run lighthouse` against a production server on port 3212 reports mobile `/app` performance 85, LCP 1222 ms, CLS 0.035; `/find-care` performance 89, LCP 1217 ms, CLS 0.000. Both meet the LCP < 2.5 s and CLS < 0.1 targets. A Chromium lab fallback is also recorded in `test-results/lighthouse/playwright-metrics.json`.
- **Screenshots:** `test-results/screens/{login,overview}-{390,768,1024,1440}.png`, plus lane A/B/C/E screenshots under `test-results/lane-*`.
- **Final checks:** typecheck ✓, lint ✓, build ✓, unit 156/156, component 164/164, e2e 28/28, live smoke ✓ (login, refresh, session, `/me/fields`, directory services, logout; no AI, no writes).

## M0 foundation (2026-11-17)
Completed on `feat/m0-foundation`:
- **Dependencies:** axios, TanStack Query (+ devtools as a dev dependency), zod, react-markdown; MSW, Vitest + coverage + jsdom + Testing Library, Playwright, axe. Arc foundation and the full scope §6 inventory installed with the shadcn CLI (brings motion, lucide-react, Radix primitives).
- **BFF (§3.1):**
  - `/api/auth/{login,register,refresh,logout,session}` set and clear `ha_at` (`Path=/`, 900 s) and `ha_rt` (`Path=/api/auth`, 30 d); both HttpOnly, SameSite=Lax, Secure only in production.
  - Tokens never appear in a response body.
  - `/api/v1/[...path]` forwards path, query and streamed multipart bodies; attaches the bearer; copies status/JSON, `Cache-Control: no-store` and `x-request-id`; maps upstream 401 to `token_expired`; blocks `/auth/*`; 190 s AI timeouts, 20 s otherwise; 504 on timeout.
  - CSRF: `X-HA-Client: web` plus an Origin matching the request Host (and forwarded headers), enforced in every mutation route handler.
  - `src/proxy.ts` guards `/app/:path*`, `/practitioner/:path*` and `/lookup`, redirects guests to `/login?next=<pathname>` and never decodes a JWT.
  - Removed the old `/api/v1` rewrite; added `/api/:path*` to the `no-store` list; tightened `Permissions-Policy` to `geolocation=()`.
- **Data layer (§3.2):** axios instance with `X-HA-Client`, `withCredentials`, 20 s timeout and `aiTimeout`; single-flight refresh (5 parallel 401s → 1 refresh, unit tested); `ApiError` mapper; query keys; TanStack defaults (`staleTime` 30 s, retry only 5xx except 503, no mutation retries); Zod parsing at the boundary.
- **Schemas and mocks:** one Zod file per API group covering all 48 snapshot endpoints, typed fixtures generated from the snapshot examples, and base MSW auth handlers. The schema test asserts every 2xx example parses and that every endpoint with a 2xx body is covered.
- **Arc and shell (§6, §7.2 without data cards):** midnight/green theme tokens in `src/styles/arc-theme.css`; Arc foundation imported only in the `(app)`, `(auth)` and `(public)` layouts; Manrope also exposed as `--font-geist`; desktop sidebar, mobile Arc drawer, topbar with Arc `UserMenu`, session gate and logout.
- **Auth (§7.1):** `/login` and `/register` with Arc inputs, password fields and password strength; generic credential error; `email_taken` mapped to the email field; inactive-account denied state; validated `next` redirect; logout in `user-menu`.
- **Tests:** 98 unit/component tests pass; 8 Playwright tests pass (guard, login → shell → logout, open-redirect rejection, axe at 390/768/1024/1440, security evidence). `test:live` passes against the real demo account (login, refresh, session, `/me/fields`, directory services, logout; no AI and no record writes).
- **Evidence:** `test-results/screens/*.png`, `test-results/security/evidence.png`, `test-results/security/grep.txt`.

## Blocked/Decisions
| # | Decision | Source |
|---|---|---|
| D1 | Landing page at `/`, assistant at `/assistant` | Q1 |
| D2 | DB's 8 field keys and types | Q2 |
| D3 | Channels shown as fictional simulations; no interactive simulator | Q3 |
| D4 | No analytics in Release 1 | Q4 |
| D5 | English only; landing strings in `src/features/landing/content.ts` | Q5 |
| D6 | No Three.js. The globe is about 100 lines of canvas 2D | Stack |
| D7 | Practitioner access lives at `/practitioner/lookup`, not `/lookup` | Audit |
| D8 | Backend points to confirm. Mock defaults: CSRF uses a double-submit cookie plus `X-CSRF-Token`; step-up auth is a 403 with `REAUTH_REQUIRED`; practitioner accounts are seeded | Audit |
| D9 | Next 16 keeps hidden routes' state alive. Screens that show codes must clear them on hide | Next 16 docs |
| D10 | **v2 redesign** follows the 21st.dev "Murmur" template's layout and motion only. No template assets are copied: the hand photo becomes a CSS phone, and the glossy images are original SVGs in `public/landing/objects/` | User request |
| D11 | **GSAP removed.** v2 motion is reveal-on-enter, done with CSS and one IntersectionObserver. This supersedes the original stack note | v2 |
| D12 | The template's email form is replaced by links. There is no newsletter backend, and collecting emails needs a consent and storage decision | v2 |
| D13 | Template sections not carried over: problem block, body-silhouette map, team. The v1 versions are in commit `76739ea` if wanted back | v2 |
| D14 | Fonts: Inter (body) plus Manrope (headings) to match the template's display face | v2 |
| D15 | **Hero hand photo:** generated with Higgsfield (`gpt_image_2_6`, job `8c2517f4…`, variant 3 of 4, about 1 credit). Higgsfield's background remover kept only the phone, so the cut-out was done locally by keying the black background (scratchpad script). Stored as `public/landing/hero/hand-phone.webp` (688×1024, 65 KB). The screen rectangle is measured in `HeroPhone.tsx`; re-measure if the image changes | User request |
| D17 | **The live API supersedes Plan 1's endpoint tables.** Base `https://healthaccess.billzpay.com.ng/v1`; snapshot in `docs/api/`. Plan 1 still governs product, security and honesty rules | API docs, 2026-11-17 |
| D18 | Auth via a Next BFF: route handlers keep access and refresh tokens in HttpOnly cookies. The generic `/api/v1/[...path]` proxy replaces the `next.config` rewrite (which also used the wrong base path) | User choice |
| D19 | Dashboard theme is dark, matching the landing page. Arc `data-theme="dark" data-accent="green"` plus `src/styles/arc-theme.css` overrides | User choice |
| D20 | Data layer: axios with a single-flight refresh, TanStack Query, Zod parsing at the boundary. `retry: false` for mutations, because the API has no idempotency keys | User choice + API |
| D21 | Dashboard UI uses Arc components via the arc MCP. The landing page stays Tailwind | User choice |
| D22 | First build includes the AI symptom assistant, medication schedules, the practitioner portal, and phone/SMS/USSD consent | User choice |
| D23 | **A separate builder model implements; this session reviews.** The builder runs parallel sub-agent lanes and must write tests. The user's note overrides their "you build it" option | User note |
| D24 | Not built: generative-UI renderer, admin, FCM/service worker, password reset, map/geolocation. The landing copy needs fixes because AI and lookup now require sign-in (scope §7.11) | API gaps |
| D25 | **Auth screens are composed from Arc primitives, not the `login-centered` block.** `login-centered` is passkey/email-code only and has no password or API callback, so it cannot implement §7.1. `signup-form` also omits name split, password confirmation, date of birth and phone. We use Arc `Input`, `PasswordField`, `PasswordStrength`, `Button`, `Alert` and a token-only panel. Report to the reviewer; if `login-centered` is mandatory, the scope needs a password variant | Component docs |
| D26 | **`proxy.ts` CSRF expected origin uses `Host` / `x-forwarded-host` plus `x-forwarded-proto`, not `request.url`.** Next 16 normalises localhost, which made a real `Origin: http://127.0.0.1:3210` fail. Still same-origin, still rejects a foreign Origin | Live smoke |
| D27 | **Tailwind's Turbopack loader is limited to non-module CSS and excludes `src/components/arc/**`.** Running it over CSS modules emptied their class exports; running it over Arc CSS failed on `:global(...)`. `globals.css` still gets Tailwind; Arc files are untouched | Build |
| D28 | **E2E runs on port 3210 with its own production build.** A developer `next dev` on 3000 shares `.next` and broke CSS during the first run. `test:e2e` starts `next build && next start` on 3210 with `reuseExistingServer: false` | Test run |
| D16 | Hero headline changed by the user to "Care Within Reach, / Wherever You Are": two equal lines, as in the reference template. This replaces approved option 1 | User request |

**Open items:**
- **[SOURCE NEEDED]:** none outstanding. v2 contains no statistics.
- `directory.web_leads` exists in the DB but not in Plan 1. If shown, label it "unverified".
- Links to `/assistant`, `/lookup`, `/register`, `/find-care` and `/login` return 404 until the builder ships those routes. The landing "Open the assistant" moves to `/app/assistant` (Lane F).
- Backend questions B1–B6 are in scope §1: allergy field vs records, duplicate condition/medication fields, `includeRecords` and the AI provider, HTTPS-only, a practitioner test account, no `GET /me/consents`.

## Review log
- **2026-11-20, M2 self-review:**
  - Overview cards load and fail independently; the overview e2e proves one failing card does not blank the others.
  - The full e2e suite is green (`28/28`). Earlier runs lost the test server to `ERR_CONNECTION_REFUSED` under parallel load; Playwright now runs one worker and reuses an existing production server outside CI, which keeps the run stable.
  - Vitest runs unit and component suites as separate commands because a single run exhausted the environment's time budget. `npm test` still covers both.
  - Lighthouse's bundled Chrome hit an interstitial in this environment. The Chromium lab fallback records LCP/CLS and both routes meet the targets; the Lighthouse script is committed for an environment where Chrome launches.
  - No new security deviation: tokens and codes stay out of storage, URLs, logs and the query cache; the security sweep passes.
- **2026-11-17, M0 self-review:**
  - Build caught three issues and they are fixed: `runtime`/`dynamic` route config is incompatible with `cacheComponents` (removed); Turbopack + Tailwind was emptying CSS-module class exports (D27); CSRF origin comparison broke on `127.0.0.1` (D26).
  - Axe caught a label-content-name mismatch in Arc `UserMenu` because the initials avatar is visible text. Fixed with an initials data-URI avatar, so the accessible name contains the visible account name.
  - Auth pages now mount `Providers`; the first draft would have thrown at runtime because `(auth)` sits outside `(app)`.
  - Verified: no `ha_*` cookie is readable from `document.cookie`; localStorage and sessionStorage are empty; the only `sessionStorage` use in `src` is the landing intro flag; the only `console.*` is `src/lib/log.ts` (path and status only).
  - Screenshots at 390/768/1024/1440: `test-results/screens/`. Security evidence: `test-results/security/evidence.png` and `grep.txt`.
  - Deviation D25 (auth block) is the only intentional UI deviation from the inventory; it needs reviewer sign-off.
- **2026-11-17, v1 self-review:**
  - Nav contrast over dark sections fixed.
  - Body-map list order fixed on mobile.
  - Preloader skip button no longer focusable after the curtain lifts.
- **2026-11-17, v2 self-review:**
  - The hero carousel label wrapped on mobile; the controls were moved out of the phone's width.
  - Step text was dimmed on mobile, where every step shows its own screen; dimming now applies only at `lg`.
  - A light strip showed below the footer; fixed with `body:has(.landing)`.
  - Phone text inherited `text-center` from the hero; fixed.
- **2026-11-17, hero rework (user feedback):** rebuilt to match Murmur.
  - Bold two-line headline behind a hand-held phone that is about 383 px wide on desktop.
  - Green glow behind the phone removed.
  - Black fade over the wrist.
  - The live UI is scaled into the photo's screen rectangle.
  - Subline is one line from 768 px up and wraps on phones.
  - No horizontal overflow at 360, 768, 1280 or 1440 px.
