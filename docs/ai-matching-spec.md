# AI-Powered Matching — Implementation Spec

Status: draft, no backend built yet (current repo is the `site/` landing page only).
Owner: TBD.
Confirmed stack: deploy on Cloudflare (Workers/D1/Pages), LLM calls via OpenRouter.

## 1. Goal

Improve match quality between buyers and sellers of used industrial/construction machinery without overclaiming what AI actually does. Two distinct AI jobs, kept separate on purpose:

1. **Extraction** — turn a seller's free-text listing into structured spec fields.
2. **Confidence / ranking** — score and explain candidate matches.

The core design decision: **the LLM extracts and explains; it does not compute the match score.** Match scoring is a calibrated statistical model trained on real outcomes, because LLMs asked to self-report a confidence number are unreliable at it — they're fluent, not calibrated.

## 2. Pipeline

### 2.1 Listing extraction (seller free text → structured JSON)

- **Input:** seller's listing title + free-text description.
- **Model:** routed through **OpenRouter**, default `google/gemini-2.5-flash-lite` with structured/JSON-schema output. `qwen/qwen-2.5-7b-instruct` (or a newer Qwen tier) as a swappable cheaper/alternative model — since both sit behind the same OpenRouter API key and request shape, switching is a config change (model string + price/quality tradeoff), not a re-integration.
- **Output schema:**
  ```json
  {
    "category": "string (enum: excavator, wheel_loader, crane, dozer, compactor, attachment, other)",
    "brand": "string | null",
    "model": "string | null",
    "year": "number | null",
    "hours_or_mileage": "number | null",
    "condition": "string (enum: new, used_good, used_fair, for_parts) | null",
    "price": "number | null",
    "currency": "string",
    "location": { "city": "string | null", "region": "string | null" },
    "features": ["string"]
  }
  ```
- **Validation:** schema validation on the response; if more than ~2 required fields come back null, route the listing to a manual-review queue instead of auto-publishing.
- **Human-in-the-loop:** seller reviews and confirms/edits the extracted fields before the listing goes live. Bad extraction shouldn't silently become bad matching data.
- **Cost:** sub-cent per listing at Flash-Lite pricing; extraction runs once per listing (and again on edit), not per match.

### 2.2 Matching (buyer criteria → ranked candidate sellers)

**Step 1 — hard filters (deterministic, no AI).** Category match, price/budget range overlap, location radius (haversine distance on geocoded location). This is a plain database query and should stay one — it's the eligibility gate, and it needs to be exact and auditable.

**Step 2 — feature scoring.** For each candidate pair that survives the filter, compute structured features:
- `spec_fit` — normalized similarity on year / hours / price against the buyer's stated range
- `price_fit` — how close to the buyer's budget midpoint
- `distance_km`
- `seller_verification_level`
- `seller_response_rate` (once available)
- `listing_freshness_days`

**Step 3 — confidence score.** Two phases, because there's no outcome data on day one:

- **Phase A (cold start).** A transparent rule-based completeness score — e.g. each matched criterion contributes evenly to a 0–100% "criteria fit." Label it as **"Criteria fit," not "AI confidence"** — it isn't learned yet, and saying so would overclaim, which conflicts with the site's existing "no guarantee" stance.
- **Phase B (post data collection).** Once enough labeled outcomes exist (see §3), train a small classical model — logistic regression or LightGBM, not an LLM — on the Step 2 features against real outcomes. Calibrate it (Platt scaling or isotonic regression) so the output is a genuine probability, not just a ranking score. This becomes the real "match confidence."

**Step 4 — explanation (LLM, narration only).** A cheap LLM call (same provider as extraction) takes the *already-computed* score and feature breakdown and writes a one- or two-sentence human-readable reason: *"Matched at high confidence — same category, within your budget, 40 km away, seller verified."* The prompt explicitly hands the model the numbers and instructs it to explain them, not recompute or second-guess them. This keeps the LLM's unreliability contained to prose, not arithmetic.

## 3. Data requirements for Phase B

- **Event logging:** every match served — `match_id`, `buyer_id`, `seller_id`, a snapshot of the Step 2 features, the score shown, timestamp.
- **Outcome capture:** lightweight, opt-in signal from both sides after a match — "contacted" (did they open/use the shared contact), and a simple post-match check-in ("did this lead to a sale / purchase?"). Yardline doesn't process the transaction itself, so this has to be self-reported, not inferred.
- **Minimum volume before training:** rough rule of thumb, several hundred to ~1,000 labeled outcomes with reasonable class balance (some closed, some not) before a learned model will outperform the Phase A heuristic.
- **Retraining cadence:** batch retrain (e.g. weekly) once volume justifies it; monitor for drift as the mix of equipment categories/regions shifts.

## 4. Model and infra choices

**Deployment target: Cloudflare** (the existing default stack) —
- **Workers** for the API/matching logic (filters, feature scoring, calls out to OpenRouter, serves the confidence + explanation).
- **D1** for structured storage — listings, buyer criteria, match events, outcomes. Serverless SQLite, fits the volumes described in §3 without needing a separate database service.
- **KV** for cheap caching where useful (e.g. geocoding lookups, recently computed feature snapshots).
- The current `site/` static build can ship as **Workers static assets** or **Pages** — either fits; Pages is the simpler default if the API ends up as a separate Worker.

**LLM access: OpenRouter**, one integration for every model call in this spec.

| Job | Default model (via OpenRouter) | Alternative | Why |
| --- | --- | --- | --- |
| Listing extraction | `google/gemini-2.5-flash-lite` | `qwen/qwen-2.5-7b-instruct` | Flash-Lite: cheap, mature structured-output support. Qwen: swap-in alternative if cost or quality tradeoffs favor it later — same API shape via OpenRouter, so this is a config change. |
| Match confidence | Logistic regression / LightGBM (self-trained, runs in the Worker or a scheduled job) | — | Needs calibration against real outcomes; an LLM can't learn this from a prompt. Not an OpenRouter call at all. |
| Match explanation | Same OpenRouter model as extraction | — | Reuse one integration; this call is narration only, low stakes if occasionally awkward phrasing. |

Note: routing through OpenRouter means requests go through whichever upstream provider it selects for that model — there's no self-hosting or guaranteed regional routing here. If data residency for the Indonesian side of the market ever becomes a hard requirement, that's a separate decision from model choice and would need revisiting against whatever OpenRouter (or a regional provider) can actually guarantee.

## 5. Honesty guardrails for what's shown to users

- Phase A shows **"Criteria fit: 3 of 4 matched"** — not "AI confidence" — until there's a real calibrated model behind it.
- Phase B shows **"Match confidence: 78%"** plus the LLM's one-line rationale.
- Every confidence display stays paired with the existing disclaimer that a match is not a guarantee of a sale or purchase (already on the site — see the "Subscription, plus commission" tile and FAQ).

## 6. Rollout phases

0. **Now** — static landing page, no backend.
1. Backend MVP: deterministic filter (§2.2 Step 1) + Phase A rule-based completeness score. No AI yet.
2. Add LLM listing extraction (§2.1) as a seller-facing feature.
3. Instrument event logging + outcome capture (§3).
4. Once the data threshold is hit: train and deploy the calibrated ranking model (Phase B) + add the LLM explanation layer (§2.2 Step 4).
5. Ongoing: retraining pipeline, drift monitoring, recalibration.

## 7. Open questions

- Who owns the post-match outcome-survey UX, and how pushy can it be without annoying users?
- Does data residency for Indonesian users require guarantees OpenRouter's routing can't provide? If so, that's a separate provider decision from everything else in this spec.
- Per-listing / per-match LLM budget ceiling — needs a number once real listing volume is estimated (OpenRouter's per-model pricing makes this easy to project once volume is known).
- Should "Criteria fit" (Phase A) ever be shown to buyers/sellers, or kept internal until Phase B is ready to avoid explaining a metric that's about to change meaning?
- D1 row/storage limits are generous but not infinite — worth a volume check once listing/match counts are estimated, so this doesn't need revisiting mid-build.
