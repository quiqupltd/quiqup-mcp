/**
 * Per-resource ownership assertion helpers.
 *
 * Why this module exists: M6 needs SOMETHING to prevent userId X from
 * calling `mark_ready_for_collection({ order_id: <Y's order> })`. Without
 * this, a hostile or buggy client could exfiltrate / mutate other
 * merchants' resources through our MCP layer, because Quiqup's gateway
 * trusts the session JWT we forward.
 *
 * Why this module is shaped as helpers (not middleware): the seven
 * disabled write tools each have different scope shapes. `adjust_stock`
 * scopes on SKU; `mark_ready_for_collection` scopes on order_id;
 * `book_inbound_slot` scopes on inbound_id; bulk tools take an upload_id
 * that maps to a tenant only after the validate phase. A single
 * wrapper-level "scope guard" would either be over-fitted to one shape or
 * over-engineered for all of them. So we expose simple helpers each tool
 * calls *inside* its handler — explicit, greppable, easy to test.
 *
 * Trust model (M6 reality): Quiqup's API gateway already gates by the
 * session JWT we send — calling `getOrder('orderY')` with userId X's JWT
 * returns 404 (or 403, depending on the endpoint) because Quiqup's
 * resolver doesn't see the order in X's scope. So in practice these
 * helpers double-confirm something the upstream already enforces.
 *
 * Why double-confirm: it surfaces the violation as a SCOPE error in our
 * audit log (vs. a generic upstream 404), and it short-circuits BEFORE
 * the dangerous side-effect call. Without this, `mark_ready_for_collection`
 * would try to PUT against a non-owned order, get a 404, and the audit log
 * would record "tried to ready_for_collection foreign order" — useful, but
 * the PUT already left an attempt trace upstream. The helper pre-empts.
 *
 * M7 lift: an org-scoped index that maps {orderId → orgId} (or similar
 * per-resource → tenant) directly, so we don't need a full GET round-trip
 * to verify scope. Right now we pay one extra upstream GET per write call.
 * Acceptable at M6 traffic; quantified in M7 perf budget.
 */

import { QuiqupHttpError, QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import type { QuiqupEnvironment } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

/**
 * Thrown by the assert* helpers when a resource is not visible under the
 * caller's session JWT. Carries the resource type + id so handlers and
 * audit logs can render a clear message.
 */
export class ScopeViolationError extends Error {
  constructor(
    public readonly resource: string,
    public readonly resourceId: string,
    public readonly userId: string,
  ) {
    super(
      `Scope violation: userId=${userId} cannot access ${resource}=${resourceId}. ` +
        `Upstream returned 404 under this user's session — the resource either ` +
        `doesn't exist or belongs to a different tenant.`,
    );
    this.name = "ScopeViolationError";
  }
}

/**
 * Confirm that `orderId` is visible under `userId`'s Quiqup session JWT
 * (i.e. is owned by this user's merchant). Throws ScopeViolationError on
 * 404, propagates other QuiqupHttpErrors (5xx etc.) unchanged.
 *
 * Wave 2 callers: invoke this at the TOP of the handler, before any
 * mutating call. Pattern:
 *   await assertOrderBelongsToUser(args.order_id, auth.userId!);
 *   // ... rest of handler ...
 */
export async function assertOrderBelongsToUser(
  orderId: string,
  userId: string,
): Promise<void> {
  if (!userId) {
    // Shouldn't happen — registerTool only invokes handlers with an auth
    // context, and write tools should reject null userId upstream of this.
    // But: fail closed if it does.
    throw new Error(
      "assertOrderBelongsToUser called without a userId — guard your handler with `if (!auth.userId) throw ...` before invoking scope helpers.",
    );
  }
  const jwt = await getQuiqupReadyJwt(userId);
  const client = new QuiqupLastmileClient({ jwt });
  try {
    await client.getOrder(orderId);
  } catch (err) {
    if (err instanceof QuiqupHttpError && err.status === 404) {
      throw new ScopeViolationError("order", orderId, userId);
    }
    throw err;
  }
}

/**
 * Confirm that `sku` is visible under `userId`'s Quiqup session JWT.
 * Same contract as assertOrderBelongsToUser. Uses the Fulfilment
 * client because SKUs live on platform-api, not api-ae.
 */
export async function assertSkuBelongsToUser(
  sku: string,
  userId: string,
): Promise<void> {
  if (!userId) {
    throw new Error(
      "assertSkuBelongsToUser called without a userId — guard your handler with `if (!auth.userId) throw ...` before invoking scope helpers.",
    );
  }
  const jwt = await getQuiqupReadyJwt(userId);
  const client = new QuiqupFulfilmentClient({ jwt });
  try {
    await client.request(
      "GET",
      `/api/fulfilment/products/${encodeURIComponent(sku)}`,
    );
  } catch (err) {
    if (err instanceof QuiqupHttpError && err.status === 404) {
      throw new ScopeViolationError("sku", sku, userId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Platform-token callers (`/agent/mcp`)
// ---------------------------------------------------------------------------

/**
 * Every order state the platform order list knows about. The platform list
 * hides `pending` orders unless a state filter is sent, so the ownership
 * probe names every state to see the caller's order whatever state it is in.
 * Source: docs/quiqup-api/references/lastmile.md "Order states".
 */
export const ALL_ORDER_STATES = [
  "pending",
  "ready_for_collection",
  "out_for_collection",
  "collected",
  "received_at_depot",
  "out_for_delivery",
  "delivery_complete",
  "collection_failed",
  "delivery_failed",
  "return_to_origin",
  "out_for_return",
  "returned_to_origin",
  "cancelled",
  "on_hold",
  "at_depot",
  "scheduled",
  "transit",
] as const;

/** Today's date in Dubai (UTC+4, no DST) as YYYY-MM-DD. */
function dubaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Pull the row array out of the list response, whatever the envelope. */
function extractRows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const key of ["results", "orders", "data", "items"]) {
      if (Array.isArray(o[key])) return o[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/**
 * Ownership check for platform-token callers. The token only ever sees its
 * own merchant's orders on platform-api, so "the order shows up in the
 * caller's own list" is the proof of ownership.
 *
 *   GET /quiqdash/orders?version=v2&page=1&per_page=1&from=2020-01-01
 *       &to=<Dubai today>&filters[order_id]=<id>&filters[state]=<all states>
 *
 * Fails closed: an unrecognised response shape, or a row whose id/uuid does
 * not equal the requested id, counts as "not owned". A 404 from the list
 * (should not happen) is also a violation; every other upstream error
 * propagates unchanged.
 */
export async function assertOrderBelongsToPlatformCaller(
  orderId: string,
  callerId: string,
  platform: { jwt: string; environment: QuiqupEnvironment },
): Promise<void> {
  const client = new PlatformApiClient({
    jwt: platform.jwt,
    environment: platform.environment,
  });
  let body: unknown;
  try {
    body = await client.request("GET", "/quiqdash/orders", {
      query: {
        version: "v2",
        page: 1,
        per_page: 1,
        from: "2020-01-01",
        to: dubaiToday(),
        "filters[order_id]": orderId,
        "filters[state]": ALL_ORDER_STATES.join(","),
      },
    });
  } catch (err) {
    if (err instanceof QuiqupHttpError && err.status === 404) {
      throw new ScopeViolationError("order", orderId, callerId);
    }
    throw err;
  }
  const found = extractRows(body).some(
    (row) => String(row.id) === orderId || row.uuid === orderId,
  );
  if (!found) {
    throw new ScopeViolationError("order", orderId, callerId);
  }
}
