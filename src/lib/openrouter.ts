import { z } from "zod";
import type { Category, Condition, Env } from "./types";

// Turns a seller's free-text listing into structured fields. This is the
// ONLY generative-AI call in the codebase, and its only job is extraction —
// it never computes a match score or a confidence number. See
// docs/ai-matching-spec.md §2.1.

const CATEGORY_VALUES = [
  "excavator",
  "wheel_loader",
  "crane",
  "dozer",
  "compactor",
  "attachment",
  "other",
] as const satisfies readonly Category[];

const CONDITION_VALUES = [
  "new",
  "used_good",
  "used_fair",
  "for_parts",
] as const satisfies readonly Condition[];

const extractionSchema = z.object({
  category: z.enum(CATEGORY_VALUES),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  hours_or_mileage: z.number().nullable(),
  condition: z.enum(CONDITION_VALUES).nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  features: z.array(z.string()),
});

export type ExtractedListing = z.infer<typeof extractionSchema>;

const REQUIRED_FIELD_KEYS = ["brand", "model", "year", "hours_or_mileage", "price"] as const;
const NEEDS_REVIEW_NULL_THRESHOLD = 2;

const JSON_SCHEMA = {
  name: "listing_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: CATEGORY_VALUES },
      brand: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      year: { type: ["integer", "null"] },
      hours_or_mileage: { type: ["number", "null"] },
      condition: { type: ["string", "null"], enum: [...CONDITION_VALUES, null] },
      price: { type: ["number", "null"] },
      currency: { type: ["string", "null"] },
      city: { type: ["string", "null"] },
      region: { type: ["string", "null"] },
      features: { type: "array", items: { type: "string" } },
    },
    required: [
      "category",
      "brand",
      "model",
      "year",
      "hours_or_mileage",
      "condition",
      "price",
      "currency",
      "city",
      "region",
      "features",
    ],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = `You extract structured fields from a used-machinery classified listing.
Only use information explicitly present in the text. If a field isn't stated, return null for it
— never guess or infer a plausible-sounding value. "features" is a short list of notable
equipment/attachments mentioned (e.g. "hydraulic thumb", "GPS ready"); return an empty array if none.`;

export interface ExtractionResult {
  fields: ExtractedListing;
  needsReview: boolean;
}

export async function extractListingFields(
  rawDescription: string,
  env: Env,
): Promise<ExtractionResult> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: rawDescription },
      ],
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter extraction failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter response had no message content");
  }

  const parsed = extractionSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Extraction response failed schema validation: ${parsed.error.message}`);
  }

  const nullRequiredCount = REQUIRED_FIELD_KEYS.filter((key) => parsed.data[key] === null).length;

  return {
    fields: parsed.data,
    needsReview: nullRequiredCount > NEEDS_REVIEW_NULL_THRESHOLD,
  };
}
