import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import { insertCriteria } from "../lib/db";
import { safeJson } from "../lib/http";
import type { Env } from "../lib/types";

const app = new Hono<{ Bindings: Env }>();

const criteriaSchema = z.object({
  category: z.enum(["excavator", "wheel_loader", "crane", "dozer", "compactor", "attachment", "other"]),
  min_year: z.number().int().nullable().default(null),
  max_year: z.number().int().nullable().default(null),
  max_hours: z.number().nullable().default(null),
  budget_min: z.number().nullable().default(null),
  budget_max: z.number().nullable().default(null),
  region: z.string().nullable().default(null),
  radius_km: z.number().nullable().default(null),
});

app.post("/", requireAuth, requireRole("buyer"), async (c) => {
  const body = criteriaSchema.safeParse(await safeJson(c));
  if (!body.success) {
    return c.json({ error: "Invalid criteria payload", details: body.error.issues }, 400);
  }

  // account_id always comes from the authenticated session now, never the
  // request body — a buyer can only ever create criteria for themselves.
  const criteria = await insertCriteria(c.env, { account_id: c.get("account").id, ...body.data });
  return c.json(criteria, 201);
});

export default app;
