import {join} from "path";
import {mkdirSync} from "fs";
import type {AppSettings} from "../src/shared/types.js";

export type { AppSettings };

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return join(process.cwd(), "data");
}

const _dataDir = resolveDataDir();

export function getDataDir(): string {
  return _dataDir;
}

function buildSettings(): AppSettings {
  mkdirSync(_dataDir, { recursive: true });
  const mask = (v?: string) => v ? v.slice(0, 6) + "..." + v.slice(-4) : "(unset)";
  const bool = (v?: string) => v ?? "(unset)";
  const e = process.env;
  console.log("[settings] Loaded env:");
  console.log(`  PORT                     = ${e.PORT ?? "(unset)"}`);
  console.log(`  MONGODB_URI              = ${e.MONGODB_URI ? "(set)" : "(unset)"}`);
  console.log(`  MONGODB_DB               = ${e.MONGODB_DB ?? "(unset)"}`);
  console.log(`  DATA_DIR                 = ${e.DATA_DIR || "(default ./data)"}`);
  console.log(`  AI_BACKEND               = ${e.AI_BACKEND ?? "(unset)"}`);
  console.log(`  OPENAI_LOCAL_API_KEY     = ${mask(e.OPENAI_LOCAL_API_KEY)}`);
  console.log(`  OPENAI_MODEL             = ${e.OPENAI_MODEL ?? "(unset)"}`);
  console.log(`  OLLAMA_URL               = ${e.OLLAMA_URL ?? "(unset)"}`);
  console.log(`  OLLAMA_MODEL             = ${e.OLLAMA_MODEL ?? "(unset)"}`);
  console.log(`  OCR_LANGUAGE             = ${e.OCR_LANGUAGE ?? "(unset)"}`);
  console.log(`  AUTO_EXTRACT             = ${bool(e.AUTO_EXTRACT)}`);
  console.log(`  EXTRACTION_MAX_CHARS     = ${e.EXTRACTION_MAX_CHARS ?? "(unset)"}`);
  console.log(`  GOOGLE_CLIENT_ID         = ${mask(e.GOOGLE_CLIENT_ID)}`);
  console.log(`  GOOGLE_CLIENT_SECRET     = ${mask(e.GOOGLE_CLIENT_SECRET)}`);
  console.log(`  GOOGLE_REDIRECT_URI      = ${e.GOOGLE_REDIRECT_URI ?? "(unset)"}`);
  console.log(`  ALLOWED_EMAILS           = ${e.ALLOWED_EMAILS || "(unset)"}`);
  console.log(`  SESSION_SECRET           = ${e.SESSION_SECRET ? "(set)" : "(unset)"}`);
  console.log(`  SMTP_HOST                = ${e.SMTP_HOST ?? "(unset)"}`);
  console.log(`  SMTP_PORT                = ${e.SMTP_PORT ?? "(unset)"}`);
  console.log(`  SMTP_SECURE              = ${bool(e.SMTP_SECURE)}`);
  console.log(`  SMTP_USER                = ${e.SMTP_USER ?? "(unset)"}`);
  console.log(`  SMTP_PASS                = ${e.SMTP_PASS ? "(set)" : "(unset)"}`);
  console.log(`  SMTP_REJECT_UNAUTHORIZED = ${bool(e.SMTP_REJECT_UNAUTHORIZED)}`);
  console.log(`  EMAIL_FROM               = ${e.EMAIL_FROM ?? "(unset)"}`);
  console.log(`  EMAIL_FROM_NAME          = ${e.EMAIL_FROM_NAME ?? "(unset)"}`);
  console.log(`  REMINDER_ENABLED         = ${bool(e.REMINDER_ENABLED)}`);
  console.log(`  REMINDER_ADVANCE_DAYS    = ${e.REMINDER_ADVANCE_DAYS ?? "(unset)"}`);
  console.log(`  REMINDER_CHECK_INTERVAL  = ${e.REMINDER_CHECK_INTERVAL_MS ?? "(unset)"}`);
  console.log(`  TEST_EMAIL               = ${e.TEST_EMAIL ?? "(unset)"}`);
  console.log(`  TEST_EMAIL_TEMPLATE_ID   = ${e.TEST_EMAIL_TEMPLATE_ID ?? "(unset)"}`);
  console.log(`  WATCH_FOLDER_ENABLED     = ${bool(e.WATCH_FOLDER_ENABLED)}`);
  console.log(`  WATCH_FOLDER             = ${e.WATCH_FOLDER || "(unset)"}`);
  console.log(`  USER_DOCUMENT_LIMIT      = ${e.USER_DOCUMENT_LIMIT ?? "(unset)"}`);
  console.log(`  PROCESS_ONLY             = ${e.PROCESS_ONLY ?? "(unset, default false)"}`);
  console.log(`  ALLOWED_ORIGINS          = ${e.ALLOWED_ORIGINS || "(unset)"}`);
  console.log(`  ENDPOINT                 = ${e.ENDPOINT ?? "(unset)"}`);
  console.log(`  REGION                   = ${e.REGION ?? "(unset)"}`);
  console.log(`  BUCKET                   = ${e.BUCKET ?? "(unset)"}`);
  console.log(`  ACCESS_KEY_ID            = ${mask(e.ACCESS_KEY_ID)}`);
  console.log(`  SECRET_ACCESS_KEY        = ${e.SECRET_ACCESS_KEY ? "(set)" : "(unset)"}`);
  return {
    theme: "light",
    port: parseInt(process.env.PORT ?? "3737"),

    aiBackend: (process.env.AI_BACKEND as "openai" | "ollama") ?? "openai",
    openAiKey: process.env.OPENAI_LOCAL_API_KEY ?? "",
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",

    ocrLanguage: process.env.OCR_LANGUAGE ?? "heb+eng",
    autoExtract: process.env.AUTO_EXTRACT !== "false",
    extractionMaxChars: parseInt(process.env.EXTRACTION_MAX_CHARS ?? "8000"),

    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: parseInt(process.env.SMTP_PORT ?? "587"),
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    smtpRejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
    emailFrom: process.env.EMAIL_FROM ?? "",
    emailFromName: process.env.EMAIL_FROM_NAME ?? "ReminderOCR",

    reminderEnabled: process.env.REMINDER_ENABLED !== "false",
    reminderAdvanceDays: (process.env.REMINDER_ADVANCE_DAYS ?? "30")
      .split(",").map(d => parseInt(d.trim())).filter(n => !isNaN(n)),
    reminderCheckIntervalMs: parseInt(process.env.REMINDER_CHECK_INTERVAL_MS ?? "60000"),
    testEmail: process.env.TEST_EMAIL ?? "",
    testEmailTemplateId: process.env.TEST_EMAIL_TEMPLATE_ID
      ? parseInt(process.env.TEST_EMAIL_TEMPLATE_ID)
      : null,

    watchFolderEnabled: process.env.WATCH_FOLDER_ENABLED === "true",
    watchFolder: process.env.WATCH_FOLDER ?? "",

    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3737/auth/google/callback",
    sessionSecret: process.env.SESSION_SECRET ?? "",
    allowedEmails: process.env.ALLOWED_EMAILS
      ? process.env.ALLOWED_EMAILS.split(",").map(e => e.trim()).filter(Boolean)
      : [],

    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
      : [],

    userDocumentLimit: parseInt(process.env.USER_DOCUMENT_LIMIT ?? "25"),
    processOnly: process.env.PROCESS_ONLY === "true",
  };
}

let _settings: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (!_settings) throw new Error("Settings not loaded — call loadSettings() at startup first");
  return _settings;
}

export function loadSettings(): AppSettings {
  _settings = buildSettings();
  return _settings;
}

/** No-op kept for call-site compatibility — settings are now env-only. */
export function saveSettings(_settings: AppSettings): void {
  // intentionally empty
}

/** No-op kept for call-site compatibility. */
export function setSetting<K extends keyof AppSettings>(_key: K, _value: AppSettings[K]): AppSettings {
  return getSettings();
}
