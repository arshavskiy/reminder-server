import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {mkdirSync, rmSync, writeFileSync} from "fs";
import {join} from "path";
import {tmpdir} from "os";
import {scanFileForKeys, shouldScanFile} from "../pipeline/keyScanner.js";

// Temporary directory for test credential files
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ks-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ── shouldScanFile ───────────────────────────────────────────────────────────

describe("shouldScanFile", () => {
  it("accepts .env files", () => {
    expect(shouldScanFile(join(tmpDir, ".env"))).toBe(true);
  });

  it("accepts .env.local", () => {
    expect(shouldScanFile(join(tmpDir, ".env.local"))).toBe(true);
  });

  it("accepts .env.production", () => {
    expect(shouldScanFile(join(tmpDir, ".env.production"))).toBe(true);
  });

  it("accepts .env.anything (startsWith .env)", () => {
    expect(shouldScanFile(join(tmpDir, ".env.staging"))).toBe(true);
  });

  it("accepts .key extension", () => {
    expect(shouldScanFile(join(tmpDir, "mykeys.key"))).toBe(true);
  });

  it("accepts .txt extension", () => {
    expect(shouldScanFile(join(tmpDir, "notes.txt"))).toBe(true);
  });

  it("accepts .yaml / .yml", () => {
    expect(shouldScanFile(join(tmpDir, "config.yaml"))).toBe(true);
    expect(shouldScanFile(join(tmpDir, "config.yml"))).toBe(true);
  });

  it("accepts credentials (no extension)", () => {
    expect(shouldScanFile(join(tmpDir, "credentials"))).toBe(true);
  });

  it("rejects .pdf", () => {
    expect(shouldScanFile(join(tmpDir, "document.pdf"))).toBe(false);
  });

  it("rejects .docx", () => {
    expect(shouldScanFile(join(tmpDir, "report.docx"))).toBe(false);
  });

  it("rejects .png", () => {
    expect(shouldScanFile(join(tmpDir, "logo.png"))).toBe(false);
  });
});

// ── scanFileForKeys ──────────────────────────────────────────────────────────

describe("scanFileForKeys", () => {
  it("returns empty found array for a non-existent file", () => {
    const r = scanFileForKeys(join(tmpDir, "does-not-exist.env"));
    expect(r.found).toHaveLength(0);
  });

  it("detects an OpenAI key", () => {
    const p = write("openai.env", "OPENAI_LOCAL_API_KEY=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");
    const r = scanFileForKeys(p);
    const match = r.found.find((f) => f.settingKey === "openAiKey");
    expect(match).toBeDefined();
    expect(match!.value).toMatch(/^sk-/);
  });

  it("detects SMTP_HOST", () => {
    const p = write("smtp.env", "SMTP_HOST=smtp.gmail.com");
    const r = scanFileForKeys(p);
    const match = r.found.find((f) => f.settingKey === "smtpHost");
    expect(match).toBeDefined();
    expect(match!.value).toBe("smtp.gmail.com");
  });

  it("detects SMTP_USER and SMTP_PASS together", () => {
    const p = write("smtp.env", "SMTP_USER=user@example.com\nSMTP_PASS=secret123");
    const r = scanFileForKeys(p);
    expect(r.found.find((f) => f.settingKey === "smtpUser")?.value).toBe("user@example.com");
    expect(r.found.find((f) => f.settingKey === "smtpPass")?.value).toBe("secret123");
  });

  it("strips surrounding quotes from values", () => {
    const p = write("quoted.env", 'SMTP_HOST="smtp.example.com"');
    const r = scanFileForKeys(p);
    expect(r.found.find((f) => f.settingKey === "smtpHost")?.value).toBe("smtp.example.com");
  });

  it("detects GOOGLE_CLIENT_ID", () => {
    const p = write("google.env", "GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com");
    const r = scanFileForKeys(p);
    expect(r.found.find((f) => f.settingKey === "googleClientId")?.value).toBe(
      "123456789-abc.apps.googleusercontent.com"
    );
  });

  it("detects MONGODB_URI", () => {
    const p = write("mongo.env", "MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db");
    const r = scanFileForKeys(p);
    const match = r.found.find((f) => f.settingKey === "_mongoUri");
    expect(match).toBeDefined();
    expect(match!.value).toContain("mongodb+srv://");
  });

  it("detects DO Spaces credentials", () => {
    const content = [
      "DO_SPACES_KEY=DOKEY123456",
      "DO_SPACES_SECRET=DOSECRET_abcdef",
      "DO_SPACES_BUCKET=my-bucket",
      "DO_SPACES_ENDPOINT=fra1.digitaloceanspaces.com",
    ].join("\n");
    const p = write("spaces.env", content);
    const r = scanFileForKeys(p);
    expect(r.found.find((f) => f.settingKey === "doSpacesKey")?.value).toBe("DOKEY123456");
    expect(r.found.find((f) => f.settingKey === "doSpacesSecret")?.value).toBe("DOSECRET_abcdef");
    expect(r.found.find((f) => f.settingKey === "doSpacesBucket")?.value).toBe("my-bucket");
    expect(r.found.find((f) => f.settingKey === "doSpacesEndpoint")?.value).toBe(
      "fra1.digitaloceanspaces.com"
    );
  });

  it("ignores values shorter than 4 chars", () => {
    const p = write("short.env", "SMTP_HOST=x");
    const r = scanFileForKeys(p);
    expect(r.found.find((f) => f.settingKey === "smtpHost")).toBeUndefined();
  });

  it("returns empty found array for a file with no matching patterns", () => {
    const p = write("random.txt", "This file has no credentials.");
    const r = scanFileForKeys(p);
    expect(r.found).toHaveLength(0);
  });

  it("stores the file path in result.file", () => {
    const p = write("test.env", "SMTP_HOST=smtp.test.com");
    const r = scanFileForKeys(p);
    expect(r.file).toBe(p);
  });
});
