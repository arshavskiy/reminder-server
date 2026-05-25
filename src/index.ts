import "dotenv/config";
import express from "express";
import cors from "cors";
import {dirname, join} from "path";
import {fileURLToPath} from "url";
import {existsSync, watch} from "fs";
import {connectDb} from "./db/db";
import {loadSettings} from "./settings";
import {startScheduler} from "./reminders/scheduler";
import {seedBuiltinTemplates} from "./templates/seedTemplates";
import {seedDefaultEmailTemplate} from "./templates/seedEmailTemplates";
import {registerDocumentRoutes} from "./routes/documents";
import {registerClientRoutes} from "./routes/clients";
import {registerContractRoutes} from "./routes/contracts";
import {registerReminderRoutes} from "./routes/reminders";
import {registerTaskRoutes} from "./routes/tasks";
import {registerSearchRoutes} from "./routes/search";
import {registerEmailRoutes} from "./routes/email";
import {registerSettingsRoutes} from "./routes/settings";
import {registerDashboardRoutes} from "./routes/dashboard";
import {registerTemplateRoutes} from "./routes/templates";
import {registerEquipmentRoutes} from "./routes/equipment";
import {registerAuthRoutes} from "./routes/auth";
import {registerUserSettingsRoutes} from "./routes/userSettings";
import {registerProfileRoutes} from "./routes/profile";
import {registerAdminRoutes} from "./routes/admin";
import {importFile} from "./pipeline/importer";
import {applyScannedKeys, scanFileForKeys, scanWatchFolder, shouldScanFile} from "./pipeline/keyScanner";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// CORS — allow Vercel frontend and local dev
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:4173"];

// Vercel deployments: any subdomain under vercel.app for this project
const VERCEL_PREVIEW_RE = /^https:\/\/reminder[a-z0-9-]*\.vercel\.app$/;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "50mb" }));

// Railway health check — must return 200 before traffic is routed
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

// Register all route modules
registerAuthRoutes(app);
registerDocumentRoutes(app);
registerClientRoutes(app);
registerContractRoutes(app);
registerReminderRoutes(app);
registerTaskRoutes(app);
registerSearchRoutes(app);
registerEmailRoutes(app);
registerSettingsRoutes(app, (updated) => {
  if (updated.watchFolderEnabled && updated.watchFolder) startWatchFolder();
});
registerDashboardRoutes(app);
registerTemplateRoutes(app);
registerEquipmentRoutes(app);
registerUserSettingsRoutes(app);
registerProfileRoutes(app);
registerAdminRoutes(app);

// Static file serving (production)
const STATIC_DIR = join(__dirname, "../../dist/client");
if (process.env.NODE_ENV === "production" && existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (_req, res) => res.sendFile(join(STATIC_DIR, "index.html")));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
async function backfillScannedCounts() {
  const { col } = await import("./db/db.js");
  const counts = await col("documents").aggregate([
    { $match: { processing_status: "done", user_id: { $exists: true } } },
    { $group: { _id: "$user_id", count: { $sum: 1 } } },
  ]).toArray() as { _id: string; count: number }[];

  for (const { _id: userId, count } of counts) {
    // Only set if field is missing — never overwrite an already-tracked counter
    await col("user_settings").updateOne(
      { user_id: userId, scanned_count: { $exists: false } },
      { $set: { scanned_count: count } }
    );
  }
  if (counts.length) console.log(`[startup] Backfilled scanned_count for ${counts.length} user(s)`);
}

async function main() {
  const settings = loadSettings();
  await connectDb();
  await backfillScannedCounts();
  await seedBuiltinTemplates();
  await seedDefaultEmailTemplate();

  app.listen(settings.port, () => {
    console.log(`[server] Running at http://localhost:${settings.port}`);
    console.log(`[server] Data dir: ${join(process.cwd(), "data")}`);
    console.log(`[server] Health check: http://localhost:${settings.port}/health`);
  });

  startScheduler();
  startWatchFolder();

  // Scan watch folder for dropped credential files on startup
  scanWatchFolder();
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});

// ── Watch folder ──────────────────────────────────────────────────────────────
const SUPPORTED_EXTS = new Set([".pdf", ".docx", ".xlsx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".tif", ".tiff"]);

function startWatchFolder() {
  const s = loadSettings();
  if (!s.watchFolderEnabled || !s.watchFolder) return;
  if (!existsSync(s.watchFolder)) {
    console.warn(`[watch] Folder not found: ${s.watchFolder}`);
    return;
  }

  console.log(`[watch] Watching: ${s.watchFolder}`);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  watch(s.watchFolder, { persistent: true }, (event, filename) => {
    if (!filename) return;
    const filePath = join(s.watchFolder, filename);
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();

    // Credential file dropped — scan and apply keys
    if (shouldScanFile(filePath)) {
      clearTimeout(pending.get(filename));
      pending.set(filename, setTimeout(() => {
        pending.delete(filename);
        if (!existsSync(filePath)) return;
        console.log(`[watch] Credential file detected: ${filename}`);
        const result = scanFileForKeys(filePath);
        if (result.found.length > 0) {
          applyScannedKeys([result]);
        }
      }, 1000));
      return;
    }

    if (!SUPPORTED_EXTS.has(ext)) return;

    clearTimeout(pending.get(filename));
    pending.set(filename, setTimeout(async () => {
      pending.delete(filename);
      if (!existsSync(filePath)) return;
      console.log(`[watch] New file detected: ${filename}`);
      try {
        await importFile(filePath);
      } catch (err) {
        console.error(`[watch] Import failed for ${filename}:`, err);
      }
    }, 1000));
  });
}
