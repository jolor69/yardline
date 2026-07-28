import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

// c.req.json() throws SyntaxError on malformed bodies, which would
// otherwise fall through to the generic 500 handler in index.ts. A bad
// request body is a client error, not a server error.
export async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Request body must be valid JSON" });
  }
}
