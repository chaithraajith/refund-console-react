// API helpers — calls go to the Railway backend via VITE_API_BASE_URL.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({
    error: `Server returned HTTP ${response.status}`,
  }));
  if (!response.ok && !data.error) {
    data.error = `Request failed with HTTP ${response.status}`;
  }
  return data;
}

export async function getConfig() {
  const r = await fetch(apiUrl("/api/config"));
  return parseResponse(r);
}

export async function startPreview(file, opts) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("namePrefix", opts.namePrefix || "");
  fd.append("restock", String(!!opts.restock));
  fd.append("notify", String(!!opts.notify));
  fd.append("sleepMs", String(opts.sleepMs ?? 300));
  if (opts.limit) fd.append("limit", String(opts.limit));
  const r = await fetch(apiUrl("/api/preview"), { method: "POST", body: fd });
  return parseResponse(r);
}

export async function startRefund(planId) {
  const r = await fetch(apiUrl("/api/refund"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, confirm: true }),
  });
  return parseResponse(r);
}

export async function getJob(jobId) {
  const r = await fetch(apiUrl(`/api/job/${jobId}`));
  return parseResponse(r);
}

export function jobToCsv(job) {
  const head = ["order_name", "order_id", "status", "amount", "currency", "shipping_refunded", "refund_id", "reason", "detail"];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(",")];
  for (const o of job.orders) {
    lines.push([o.orderName, o.orderId, o.status, o.amount, o.currency,
      o.shippingRefunded ? "yes" : "no", o.refundId, o.reason, o.detail].map(esc).join(","));
  }
  return lines.join("\n");
}