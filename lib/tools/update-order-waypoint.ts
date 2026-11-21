import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
// Update one waypoint (pickup OR drop-off) on a Quiqup last-mile order via
// the OMS "ex-api" surface that powers orders.quiqup.com. Same Clerk-exchanged
// session-JWT as the public last-mile API, different base host. One call
// updates one waypoint — `waypoint_type` selects which.
//
// Operationally this can redirect a courier mid-flight (e.g. customer asks
// for the parcel to be dropped at a new address). The upstream gates which
// states allow the update; we don't pre-check state here — surface the
// rejection body via QuiqupHttpError if the order is too far along.
const EX_API_BASE_URL =
  process.env.QUIQUP_EX_API_BASE_URL ?? "https://ex-api.quiqup.com";

const coordinate = z.union([z.string(), z.number()]);

const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  waypoint_type: z.enum(["origin", "destination"]),
  address1: z.string().min(1, "address1 is required"),
  address2: z.string().nullable().optional(),
  town: z.string().min(1, "town is required"),
  country: z
    .string()
    .min(2, "country is required (ISO-3166 alpha-2, e.g. 'AE')"),
  coordinates: z.object({
    lat: coordinate,
    lng: coordinate,
  }),
  apartment_number: z.string().nullable().optional(),
  core_api_location_id: z.string().nullable().optional(),
  // OMS sends "oms_update". Surfaced as an optional override; the API is the
  // source of truth on accepted values.
  pin_check_type: z.string().optional(),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_order_waypoint",
  description:
    "Update the pickup (`waypoint_type: 'origin'`) or drop-off " +
    "(`waypoint_type: 'destination'`) address on a Quiqup last-mile order. " +
    "Targets the OMS surface at ex-api.quiqup.com — the same endpoint " +
    "orders.quiqup.com uses when an operator edits an address mid-flight. " +
    "One call updates one waypoint. Coordinates are required (lat/lng as " +
    "strings or numbers). The upstream API decides whether the order's " +
    "current state allows the update; if it doesn't, the call rejects with " +
    "the upstream error body. Use sparingly — this can redirect a courier.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId)
      throw new Error("update_order_waypoint requires an authenticated user");
    const jwt = await jwtFor(auth);
    const client = new QuiqupLastmileClient({ jwt, baseUrl: EX_API_BASE_URL });

    const {
      order_id,
      waypoint_type,
      address1,
      address2,
      town,
      country,
      coordinates,
      apartment_number,
      core_api_location_id,
      pin_check_type,
    } = args;

    const body = {
      address1,
      address2: address2 ?? null,
      town,
      country,
      coordinates: {
        lat: String(coordinates.lat),
        lng: String(coordinates.lng),
      },
      apartment_number: apartment_number ?? null,
      core_api_location_id: core_api_location_id ?? null,
      waypoint_type,
      pin_check_type: pin_check_type ?? "oms_update",
    };

    const data = await client.request(
      "PUT",
      `/orders/${encodeURIComponent(order_id)}/waypoints`,
      { body },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
