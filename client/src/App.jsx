import React, { useEffect, useRef, useState } from "react";
import { getConfig, startPreview, startRefund, getJob, jobToCsv } from "./api.js";

const fmtMoney = (amt, cur) => (amt != null ? `${parseFloat(amt).toFixed(2)} ${cur || ""}`.trim() : "—");
const totalsStr = (totals) =>
  Object.entries(totals || {}).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(" + ") || "0";

function Stat({ n, label }) {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function statusClass(s) {
  if (s === "refunded" || s === "planned") return "t-ok";
  if (s === "failed") return "t-err";
  return "t-warn";
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [file, setFile] = useState(null);
  const [opts, setOpts] = useState({ namePrefix: "", limit: "", sleepMs: 300, restock: false, notify: false });
  const [planId, setPlanId] = useState(null);
  const [job, setJob] = useState(null);         // current job being polled
  const [phase, setPhase] = useState("idle");   // idle | previewing | preview_done | refunding | refund_done
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const pollRef = useRef(null);

  useEffect(() => { getConfig().then(setCfg); }, []);
  useEffect(() => () => clearInterval(pollRef.current), []);

  function poll(jobId, onDone) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const j = await getJob(jobId);
      setJob(j);
      if (j.status !== "running") {
        clearInterval(pollRef.current);
        onDone(j);
      }
    }, 800);
  }

  async function onPreview() {
    if (!file) return;
    setNote("Uploading…");
    setConfirmed(false);
    const resp = await startPreview(file, opts);
    if (resp.error) { setNote(resp.error); return; }
    setNote("");
    setPlanId(resp.jobId);
    setPhase("previewing");
    poll(resp.jobId, () => setPhase("preview_done"));
  }

  async function onRefund() {
    if (!planId) return;
    setConfirmed(false);
    const resp = await startRefund(planId);
    if (resp.error) { setNote(resp.error); return; }
    setPhase("refunding");
    poll(resp.jobId, () => setPhase("refund_done"));
  }

  function downloadCsv() {
    if (!job) return;
    const blob = new Blob([jobToCsv(job)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (job.type === "refund" ? "refund_results" : "refund_plan") + ".csv";
    a.click();
  }

  const busy = phase === "previewing" || phase === "refunding";
  const showResults = job && (phase === "preview_done" || phase === "refunding" || phase === "refund_done");
  const refundable = job ? job.orders.filter((o) => o.refundable) : [];
  const skippedN = job ? job.orders.length - refundable.length : 0;
  const shipN = refundable.filter((o) => o.shippingRefunded).length;
  const isRefundView = job && job.type === "refund";

  return (
    <div className="wrap">
      <h1>Refund console</h1>
      <p className="sub">
        Upload the refund journal, preview what will be refunded, then approve.{" "}
        {cfg && (
          <span className="badge">
            {cfg.store ? `Store: ${cfg.store}${cfg.hasToken ? "" : " — NO TOKEN SET"}` : "No store configured"}
          </span>
        )}
      </p>

      {/* upload + options */}
      <div className="card">
        <label className="drop">
          <input
            type="file"
            accept=".xlsx"
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files[0] || null)}
          />
          {file ? file.name : "Click to choose the .xlsx"}
        </label>

        <div className="row" style={{ marginTop: 14 }}>
          <div>
            <label className="lbl">Order name prefix (if orders are #ORD519056)</label>
            <input type="text" value={opts.namePrefix} placeholder="(none)"
              onChange={(e) => setOpts({ ...opts, namePrefix: e.target.value })} />
          </div>
          <div>
            <label className="lbl">Limit orders (blank = all)</label>
            <input type="number" min="1" value={opts.limit} placeholder="e.g. 20"
              onChange={(e) => setOpts({ ...opts, limit: e.target.value })} />
          </div>
          <div>
            <label className="lbl">Pause between orders (ms)</label>
            <input type="number" min="0" value={opts.sleepMs}
              onChange={(e) => setOpts({ ...opts, sleepMs: e.target.value })} />
          </div>
        </div>

        <div className="checks">
          <label><input type="checkbox" checked={opts.restock}
            onChange={(e) => setOpts({ ...opts, restock: e.target.checked })} /> Restock items</label>
          <label><input type="checkbox" checked={opts.notify}
            onChange={(e) => setOpts({ ...opts, notify: e.target.checked })} /> Email customers</label>
        </div>

        <div style={{ marginTop: 14 }}>
          <button onClick={onPreview} disabled={!file || busy}>Preview refunds</button>
          {note && <span className="note">{note}</span>}
        </div>
      </div>

      {/* progress */}
      {busy && job && (
        <div className="card">
          <div className="progress-head">
            <strong>{phase === "refunding" ? "Processing refunds…" : "Previewing…"}</strong>
            <span className="mono">{job.processed} / {job.total}</span>
          </div>
          <div className="bar">
            <i style={{ width: `${job.total ? Math.round((100 * job.processed) / job.total) : 0}%` }} />
          </div>
        </div>
      )}

      {/* results */}
      {showResults && (
        <>
          <div className="cards">
            <Stat n={totalsStr(job.totals)} label={isRefundView ? "Total refunded" : "Total to refund"} />
            <Stat n={refundable.length} label="Refundable orders" />
            <Stat n={skippedN} label="Skipped" />
            <Stat n={shipN} label="Incl. shipping" />
          </div>

          <div className="card">
            <div className="table-head">
              <strong>{isRefundView ? "Refund results" : "Planned refunds"}</strong>
              <button className="secondary" onClick={downloadCsv}>Download CSV</button>
            </div>
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Order</th><th>Status</th><th className="right">Amount</th><th>Shipping</th><th>Lines</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {job.orders.map((o, i) => {
                    const linesOk = o.lines.filter((l) => l.status === "ok").length;
                    const issues = o.lines.filter((l) => l.status !== "ok").map((l) => `${l.sku}:${l.status}`).join("; ");
                    const noteCell = o.reason ? `${o.reason}${o.detail ? ` (${o.detail})` : ""}` : issues;
                    return (
                      <tr key={i}>
                        <td className="mono">{o.orderName}</td>
                        <td><span className={`tag ${statusClass(o.status)}`}>{o.status}</span></td>
                        <td className="right mono">{fmtMoney(o.amount, o.currency)}</td>
                        <td>{o.shippingRefunded ? "yes" : "—"}</td>
                        <td>{linesOk}</td>
                        <td className="muted">{noteCell}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* approve — only after a finished preview with something refundable */}
          {phase === "preview_done" && refundable.length > 0 && (
            <div className="card">
              <strong>Approve &amp; process refunds</strong>
              <p className="note">
                This creates real refunds in Shopify for every “planned” order above. Skipped orders are not
                touched. This can’t be undone.
              </p>
              <label className="confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I’ve reviewed the amounts and want to process these refunds.
              </label>
              <button className="danger" disabled={!confirmed} onClick={onRefund}>Process refunds</button>
            </div>
          )}

          {phase === "preview_done" && refundable.length === 0 && (
            <div className="card"><span className="muted">Nothing is refundable in this file — every order was skipped. See the Note column.</span></div>
          )}

          {phase === "refund_done" && (
            <div className="card"><strong>Done.</strong> <span className="muted">Refunds processed — download the CSV for your records.</span></div>
          )}
        </>
      )}
    </div>
  );
}
