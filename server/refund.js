/*
 * Shopify refund logic — the token lives here (server-side) and never reaches
 * the browser. Shared by the preview (dry-run) and refund (live) jobs.
 */
import crypto from "node:crypto";
import * as XLSX from "xlsx";

const API_VERSION = "2026-07";
const SHEET_NAME = "sheet1";
const ALREADY_REFUNDED_STATES = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getConfig() {
  const hasToken = !!process.env.SHOPIFY_ADMIN_TOKEN ||
    !!(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
  const authMode = process.env.SHOPIFY_ADMIN_TOKEN ? "token"
    : (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) ? "client_credentials" : "none";
  return { store: process.env.SHOPIFY_STORE || null, hasToken, authMode };
}

function endpoint() {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("Set SHOPIFY_STORE (your-store.myshopify.com).");
  return `https://${store}/admin/api/${API_VERSION}/graphql.json`;
}

/*
 * Access token.
 *   - If SHOPIFY_ADMIN_TOKEN is set (legacy custom app), use it directly.
 *   - Otherwise exchange SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a token
 *     via the client-credentials grant (Dev Dashboard app on your own store).
 *     These tokens expire (~24h), so we cache and auto-refresh.
 */
let tokenCache = { token: null, expiresAt: 0 };
function invalidateToken() { tokenCache = { token: null, expiresAt: 0 }; }

async function getAccessToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;

  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60000) return tokenCache.token;

  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!store || !clientId || !clientSecret) {
    throw new Error("Set SHOPIFY_STORE and either SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.");
  }

  const resp = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!resp.ok) {
    throw new Error(`Token request failed: HTTP ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  const ttl = data.expires_in ? data.expires_in * 1000 : 24 * 60 * 60 * 1000;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttl };
  return tokenCache.token;
}

async function gql(query, variables, maxRetries = 5) {
  const url = endpoint();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const token = await getAccessToken();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      if (attempt < maxRetries - 1) { await sleep(2000 * (attempt + 1)); continue; }
      throw e;
    }
    if (resp.status === 401) {
      invalidateToken(); // token may have expired mid-run; refresh and retry
      if (attempt < maxRetries - 1) { await sleep(500); continue; }
      throw new Error("401 Unauthorized — check the app's scopes (read_orders, write_orders) and credentials.");
    }
    if ([429, 502, 503].includes(resp.status)) { await sleep(2000 * (attempt + 1)); continue; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const body = await resp.json();
    if (body.errors) {
      const throttled = body.errors.some((e) => e?.extensions?.code === "THROTTLED");
      if (throttled && attempt < maxRetries - 1) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
  }
  throw new Error("Exhausted retries contacting Shopify.");
}

const ORDER_QUERY = `
query ($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      id name displayFinancialStatus
      refunds { id }
      transactions(first: 20) { id kind status gateway parentTransaction { id } }
      lineItems(first: 250) { nodes { id sku title quantity refundableQuantity } }
    }
  }
}`;

const SUGGESTED_QUERY = `
query ($id: ID!, $refundLineItems: [RefundLineItemInput!]!, $refundShipping: Boolean) {
  order(id: $id) {
    suggestedRefund(refundLineItems: $refundLineItems, refundShipping: $refundShipping) {
      amountSet { presentmentMoney { amount currencyCode } }
      suggestedTransactions {
        gateway parentTransaction { id }
        amountSet { presentmentMoney { amount currencyCode } }
      }
    }
  }
}`;

function refundCreateMutation(idempotencyKey) {
  return `
mutation ($input: RefundInput!) {
  refundCreate(input: $input) @idempotent(key: "${idempotencyKey}") {
    refund {
      id
      totalRefundedSet {
        presentmentMoney { amount currencyCode }
        shopMoney { amount currencyCode }
      }
    }
    userErrors { field message }
  }
}`;
}

/** totalRefundedSet is 0 until gateway transactions leave pending (Shopify API behavior). */
function resolvedRefundAmount(refund, expectedAmount, expectedCurrency) {
  const bags = [
    refund?.totalRefundedSet?.presentmentMoney,
    refund?.totalRefundedSet?.shopMoney,
  ];
  for (const m of bags) {
    const n = parseFloat(m?.amount);
    if (Number.isFinite(n) && n > 0) {
      return { amount: m.amount, currency: m.currencyCode, settlementPending: false };
    }
  }
  return { amount: expectedAmount, currency: expectedCurrency, settlementPending: true };
}

async function findOrder(orderName, namePrefix) {
  const searchName = `${namePrefix}${orderName}`;
  const data = await gql(ORDER_QUERY, { q: `name:${searchName}` });
  const nodes = data.orders.nodes;
  if (!nodes.length) return null;
  const target = searchName.replace(/^#/, "").trim().toLowerCase();
  for (const n of nodes) if (n.name.replace(/^#/, "").trim().toLowerCase() === target) return n;
  return nodes.length === 1 ? nodes[0] : null;
}

function alreadyRefunded(order) {
  if (order.refunds && order.refunds.length) return true;
  return ALREADY_REFUNDED_STATES.has(order.displayFinancialStatus);
}

/*
 * One order. Returns a record describing what happened / would happen.
 * When live=true and the order is refundable, the refund is created.
 */
export async function processOrder(orderName, skuRows, opts, live) {
  const rec = {
    orderName, orderId: null, refundable: false, status: "skipped",
    amount: null, currency: null, shippingRefunded: false,
    refundId: null, reason: null, detail: null, lines: [],
  };

  let order;
  try {
    order = await findOrder(orderName, opts.namePrefix);
  } catch (e) {
    rec.status = "failed"; rec.reason = "lookup_error"; rec.detail = e.message; return rec;
  }
  if (!order) { rec.reason = "order_not_found"; return rec; }
  rec.orderId = order.id;

  if (alreadyRefunded(order)) {
    rec.reason = "already_refunded"; rec.detail = order.displayFinancialStatus || ""; return rec;
  }

  const liBySku = {};
  for (const li of order.lineItems.nodes) if (li.sku) liBySku[li.sku.trim().toLowerCase()] = li;

  const restockType = opts.restock ? "RETURN" : "NO_RESTOCK";
  const refundLineItems = [];
  for (const [sku, qty] of skuRows) {
    const li = liBySku[sku.toLowerCase()];
    if (!li) { rec.lines.push({ sku, requested: qty, used: 0, status: "sku_not_on_order" }); continue; }
    if (li.refundableQuantity <= 0) { rec.lines.push({ sku, requested: qty, used: 0, status: "nothing_refundable" }); continue; }
    const used = Math.min(qty, li.refundableQuantity);
    refundLineItems.push({ lineItemId: li.id, quantity: used, restockType });
    rec.lines.push({ sku, requested: qty, used, status: "ok" });
  }

  if (!refundLineItems.length) { rec.reason = "no_refundable_lines"; return rec; }

  const usedById = Object.fromEntries(refundLineItems.map((r) => [r.lineItemId, r.quantity]));
  const refundableLines = order.lineItems.nodes.filter((li) => li.refundableQuantity > 0);
  const refundingAll = refundableLines.length > 0 &&
    refundableLines.every((li) => usedById[li.id] === li.refundableQuantity);

  let suggestion;
  try {
    const data = await gql(SUGGESTED_QUERY, { id: order.id, refundLineItems, refundShipping: refundingAll });
    suggestion = data.order.suggestedRefund;
  } catch (e) {
    rec.status = "failed"; rec.reason = "suggest_error"; rec.detail = e.message; return rec;
  }

  const txns = (suggestion?.suggestedTransactions || []).filter((t) => t.parentTransaction);
  if (!suggestion || !txns.length) { rec.reason = "no_refundable_payment"; return rec; }

  const amount = suggestion.amountSet.presentmentMoney;
  rec.refundable = true;
  rec.amount = amount.amount;
  rec.currency = amount.currencyCode;
  rec.shippingRefunded = refundingAll;

  if (!live) { rec.status = "planned"; return rec; }

  const transactions = txns.map((t) => ({
    orderId: order.id, gateway: t.gateway, kind: "REFUND",
    parentId: t.parentTransaction.id, amount: t.amountSet.presentmentMoney.amount,
  }));
  const input = { orderId: order.id, note: opts.note, notify: opts.notify, refundLineItems, transactions };
  if (refundingAll) input.shipping = { fullRefund: true };

  const expectedAmount = rec.amount;
  const expectedCurrency = rec.currency;
  const idempotencyKey = crypto.randomUUID();
  try {
    const data = await gql(refundCreateMutation(idempotencyKey), { input });
    const r = data.refundCreate;
    if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
    rec.status = "refunded"; rec.refundId = r.refund.id;
    const resolved = resolvedRefundAmount(r.refund, expectedAmount, expectedCurrency);
    rec.amount = resolved.amount;
    rec.currency = resolved.currency;
    if (resolved.settlementPending) {
      rec.detail = "Refund created; payment still settling (amount from preview until gateway completes)";
    }
  } catch (e) {
    rec.status = "failed"; rec.reason = "refund_error"; rec.detail = e.message;
  }
  return rec;
}

// --------------------------------------------------------------------------- //
// Spreadsheet parsing
// --------------------------------------------------------------------------- //
function resolveSheet(wb) {
  const hit = wb.SheetNames.find((n) => n.trim().toLowerCase() === SHEET_NAME);
  if (hit) return hit;
  if (wb.SheetNames.length === 1) return wb.SheetNames[0];
  throw new Error(`Sheet "${SHEET_NAME}" not found. Sheets: ${wb.SheetNames.join(", ")}`);
}

function isHeaderOrBlank(orderName, sku) {
  if (!orderName || !sku) return true;
  const o = String(orderName).trim().toLowerCase();
  const s = String(sku).trim().toLowerCase();
  return s === "sku" || o === "sku" || o.startsWith("platform") || o.includes("order number");
}

export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = resolveSheet(wb);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });
  const orders = new Map();
  for (const row of rows) {
    const orderName = row[0], sku = row[1], qty = row[2];
    if (isHeaderOrBlank(orderName, sku)) continue;
    let q = parseInt(qty, 10);
    if (!Number.isInteger(q) || q <= 0) q = 1;
    const key = String(orderName).trim();
    if (!orders.has(key)) orders.set(key, []);
    orders.get(key).push([String(sku).trim(), q]);
  }
  if (!orders.size) throw new Error(`No order rows found on sheet "${sheetName}".`);
  return orders;
}
