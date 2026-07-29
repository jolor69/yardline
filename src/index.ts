import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import admin from "./routes/admin";
import auth from "./routes/auth";
import criteria from "./routes/criteria";
import listings from "./routes/listings";
import match from "./routes/match";
import matchesMine from "./routes/matches-mine";
import messages from "./routes/messages";
import outcomes from "./routes/outcomes";
import { listingPhotos, photoServe } from "./routes/photos";
import type { Env } from "./lib/types";

function jsonError(err: unknown, c: Context) {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
}
const jsonNotFound = (c: Context) => c.json({ error: "Not found" }, 404);

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.onError(jsonError);
app.notFound(jsonNotFound);

// Sub-apps mounted via .route() get their own default 404/error handlers —
// they don't inherit the parent's. Without these, unmatched /api/* routes
// silently fall through to Hono's default empty-body 404 instead of JSON.
const api = new Hono<{ Bindings: Env }>();
api.onError(jsonError);
api.notFound(jsonNotFound);
api.route("/auth", auth);
api.route("/listings", listings);
api.route("/listings", listingPhotos);
api.route("/criteria", criteria);
api.route("/match", match);
api.route("/matches", outcomes);
api.route("/matches", matchesMine);
api.route("/photos", photoServe);
api.route("/messages", messages);
api.route("/admin", admin);

app.route("/api", api);

// Everything that isn't /api/* falls through to the static site (site/).
// Explicitly guard the /api prefix here too: Hono's .route() mounting does
// not reliably delegate an unmatched sub-path to the sub-app's notFound —
// without this check, a typo'd /api/* route silently 404s with the static
// site's empty-body response instead of api's JSON one.
app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) {
    return jsonNotFound(c);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
