/*
 * Express API for the refund console + serves the built React client.
 * Endpoints:
 *   GET  /api/config          -> { store, hasToken }
 *   POST /api/preview (file)  -> { jobId, total }   (dry run job)
 *   POST /api/refund {planId} -> { jobId, total }   (live job)
 *   GET  /api/job/:id         -> job progress + records
 */
import "dotenv/config"; // loads .env at the project root into process.env
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import { parseWorkbook, processOrder, getConfig } from "./refund.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
const PORT = process.env.PORT || 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- in-memory jobs + plans ---
const JOBS = new Map();
const PLANS = new Map();

function newJob(type, total) {
  const id = crypto.randomUUID();
  JOBS.set(id, { id, type, status: "running", total, processed: 0,
    startedAt: Date.now(), orders: [], totals: {}, planId: null, error: null });
  return JOBS.get(id);
}

async function runJob(job, orders, opts, live) {
  try {
    for (const [orderName, skuRows] of orders.entries()) {
      const rec = await processOrder(orderName, skuRows, opts, live);
      job.orders.push(rec);
      if (rec.refundable) {
        const cur = rec.currency || "?";
        job.totals[cur] = (job.totals[cur] || 0) + parseFloat(rec.amount || 0);
      }
      job.processed++;
      if (opts.sleepMs > 0) await sleep(opts.sleepMs);
    }
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e.message;
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json());

app.get("/api/config", (req, res) => res.json(getConfig()));

app.post("/api/preview", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  let orders;
  try {
    orders = parseWorkbook(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const opts = {
    namePrefix: req.body.namePrefix || "",
    restock: req.body.restock === "true",
    notify: req.body.notify === "true",
    note: req.body.note || "RTO refund (batch)",
    sleepMs: Math.max(0, parseInt(req.body.sleepMs ?? "300", 10) || 0),
  };
  if (req.body.limit) {
    const lim = parseInt(req.body.limit, 10);
    if (Number.isInteger(lim) && lim > 0) orders = new Map([...orders].slice(0, lim));
  }
  const job = newJob("preview", orders.size);
  job.planId = job.id;
  PLANS.set(job.id, { orders, opts });
  runJob(job, orders, opts, false);
  res.json({ jobId: job.id, total: orders.size });
});

app.post("/api/refund", (req, res) => {
  const { planId, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: "Refund not confirmed." });
  const plan = PLANS.get(planId);
  if (!plan) return res.status(404).json({ error: "Plan not found or expired. Run a preview first." });
  const job = newJob("refund", plan.orders.size);
  job.planId = planId;
  runJob(job, plan.orders, plan.opts, true);
  res.json({ jobId: job.id, total: plan.orders.size });
});

app.get("/api/job/:id", (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

// Serve the built React client if present.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
} else {
  app.get("/", (req, res) =>
    res.status(200).send("Client not built yet. Run `npm run build`, then reload. (API is live.)"));
}

http.createServer(app).listen(PORT, () => {
  console.log(`Refund console on http://localhost:${PORT}`);
  const cfg = getConfig();
  if (!cfg.hasToken) console.log("WARNING: SHOPIFY_ADMIN_TOKEN not set.");
  if (!fs.existsSync(CLIENT_DIST)) console.log("Client not built. Run `npm run build`.");
});
