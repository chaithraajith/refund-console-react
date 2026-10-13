// Thin API helpers — all calls are same-origin (or proxied in dev).
export async function getConfig() {
  const r = await fetch("/api/config");
  return r.json();
}

export async function startPreview(file, opts) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("namePrefix", opts.namePrefix || "");
  fd.append("restock", String(!!opts.restock));
  fd.append("notify", String(!!opts.notify));
  fd.append("sleepMs", String(opts.sleepMs ?? 300));
  if (opts.limit) fd.append("limit", String(opts.limit));
  const r = await fetch("/api/preview", { method: "POST", body: fd });
  return r.json();
}

export async function startRefund(planId) {
  const r = await fetch("/api/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, confirm: true }),
  });
  return r.json();
}

export async function getJob(jobId) {
  const r = await fetch(`/api/job/${jobId}`);
  return r.json();
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
