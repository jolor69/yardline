import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { getMatch, insertOutcome } from "../lib/db";
import { safeJson } from "../lib/http";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

const outcomeSchema = z.object({
  outcome: z.enum(["contacted", "closed_sale", "closed_purchase", "no_result"]),
});

// This is the data spec §3 depends on — without outcomes being reported,
// there's never enough signal to move past the Phase A rule-based score.
//
// Only the buyer or seller on THIS match, and only once admin has
// approved it, can report an outcome — a match neither party can see yet
// obviously can't have an outcome reported on it either. `reported_by` is
// derived from the caller's session role, never trusted from the request
// body (the old version let a client claim to be either side).
app.post("/:id/outcome", requireAuth, async (c) => {
  const matchId = Number(c.req.param("id"));
  if (!Number.isInteger(matchId)) return c.json({ error: "Invalid match id" }, 400);

  const match = await getMatch(c.env, matchId);
  if (!match) return c.json({ error: "Match not found" }, 404);
  if (!match.admin_approved_at) return c.json({ error: "Match not found" }, 404); // don't reveal existence pre-approval

  const actor = c.get("account");
  let reportedBy: "buyer" | "seller";
  if (actor.role === "buyer" && match.buyer_account_id === actor.id) {
    reportedBy = "buyer";
  } else if (actor.role === "seller" && match.seller_account_id === actor.id) {
    reportedBy = "seller";
  } else {
    return c.json({ error: "You aren't a party to this match" }, 403);
  }

  const body = outcomeSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid outcome payload", details: body.error.issues }, 400);
  }

  await insertOutcome(c.env, matchId, body.data.outcome, reportedBy);
  return c.json({ ok: true }, 201);
});

export default app;
