import express from "express";
import {extname, join} from "path";
import {mkdirSync, writeFileSync} from "fs";
import {col} from "../db/db";
import {ObjectId} from "mongodb";
import {importFile, processDocument} from "../pipeline/importer";
import {getDataDir, getSettings} from "../settings";
import {HTTPException, requireAuth} from "../auth/middleware";
import {resolveDocumentFilePath} from "../documents/fileResolver";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

export function registerDocumentRoutes(app: express.Application) {
  // GET /api/documents
  app.get("/api/documents", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const status = req.query.status as string | undefined;
    const limit = parseInt((req.query.limit as string) ?? "50");
    const offset = parseInt((req.query.offset as string) ?? "0");

    // Claim any legacy documents that were imported before auth existed
    await col("documents").updateMany(
      { user_id: { $exists: false } },
      { $set: { user_id: userId, updated_at: new Date() } }
    );

    const baseFilter: Record<string, any> = { user_id: userId };
    const filter: Record<string, any> = { ...baseFilter };
    if (status) filter.processing_status = status;

    const [rows, total, userSettings] = await Promise.all([
      col("documents")
        .find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      col("documents").countDocuments(filter),
      col("user_settings").findOne({ user_id: userId }),
    ]);

    const us = userSettings as any;
    console.log(`[documents] userId=${userId} user_settings:`, us ? { scanned_count: us.scanned_count, document_limit: us.document_limit } : "NOT FOUND");
    const totalAll: number = us?.scanned_count ?? 0;
    const documentLimit: number = us?.document_limit ?? getSettings().userDocumentLimit;

    res.json({ rows: rows.map(flatDoc), total, totalAll, documentLimit });
  });

  // GET /api/documents/:id
  app.get("/api/documents/:id", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const filter = { ...idFilter(req.params.id), user_id: userId };
    const doc = await col("documents").findOne(filter);
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(flatDoc(doc));
  });

  // POST /api/documents/import
  app.post("/api/documents/import", async (req, res) => {
    let userId: string;
    let userRole: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
      userRole = ctx.user.role;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    if (userRole === "user") {
      const us = await col("user_settings").findOne({ user_id: userId }) as any;
      const scanned: number = us?.scanned_count ?? 0;
      const limit: number = us?.document_limit ?? getSettings().userDocumentLimit;
      if (scanned >= limit) {
        res.status(403).json({ error: "document_limit_reached" });
        return;
      }
    }

    const body = req.body as { filePath?: string };
    if (!body.filePath) {
      res.status(400).json({ error: "filePath required" });
      return;
    }
    try {
      const result = await importFile(body.filePath, undefined, userId);
      res.json({ id: result.id, duplicate: result.duplicate });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/documents/upload — receives multipart file upload from browser
  app.post("/api/documents/upload", upload.array("files"), async (req, res) => {
    let userId: string;
    let userRole: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
      userRole = ctx.user.role;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "no files" });
        return;
      }

      if (userRole === "user") {
        const us = await col("user_settings").findOne({ user_id: userId }) as any;
        const scanned: number = us?.scanned_count ?? 0;
        const limit: number = us?.document_limit ?? getSettings().userDocumentLimit;
        const remaining = limit - scanned;
        if (remaining <= 0) {
          res.status(403).json({ error: "document_limit_reached" });
          return;
        }
        if (files.length > remaining) {
          res.status(403).json({
            error: "document_limit_reached",
            message: `ניתן להעלות עוד ${remaining} מסמך/ים בלבד (מגבלה: ${limit})`,
            remaining,
            limit,
          });
          return;
        }
      }

      const uploadDir = join(getDataDir(), "uploads");
      mkdirSync(uploadDir, { recursive: true });

      const ids: string[] = [];
      const duplicates: string[] = [];
      for (const file of files) {
        const ext = extname(file.originalname) || "";
        const destPath = join(uploadDir, `${Date.now()}${ext}`);
        writeFileSync(destPath, file.buffer);
        // Decode originalname: multer receives it as latin1 bytes when the browser
        // sends a UTF-8 filename without RFC 5987 encoding — re-encode it correctly.
        let displayName = file.originalname;
        try {
          displayName = Buffer.from(file.originalname, "latin1").toString("utf8");
          // If the result contains replacement chars, the name was already UTF-8
          if (displayName.includes("�")) displayName = file.originalname;
        } catch { /* keep original */ }
        console.log(`[upload] "${displayName}" saved to ${destPath} (${file.size} bytes)`);
        const result = await importFile(destPath, undefined, userId, displayName);
        ids.push(result.id);
        if (result.duplicate) duplicates.push(result.fileName);
      }

      res.json({ ids, duplicates });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/documents/:id
  app.delete("/api/documents/:id", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    await col("documents").deleteOne({ ...idFilter(req.params.id), user_id: userId });
    res.json({ ok: true });
  });

  // DELETE /api/documents/corrupt — delete all error-status docs for the user
  app.delete("/api/documents/corrupt", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const errorDocs = await col("documents")
      .find({ user_id: userId, processing_status: "error" })
      .project({ _id: 1 })
      .toArray();

    const ids = errorDocs.map((d: any) => d._id?.toString());
    if (ids.length === 0) {
      res.json({ deleted: 0 });
      return;
    }

    // Delete all derived data for each corrupt document
    for (const id of ids) {
      await col("extractions").deleteMany({ document_id: id });
      await col("tasks").deleteMany({ document_id: id });
      await col("document_clients").deleteMany({ document_id: id });
      await col("timeline_events").deleteMany({ source_type: "document", source_id: id });

      const contracts = await col("contracts").find({ document_id: id }).toArray();
      const contractIds = contracts.map((c: any) => c._id?.toString());
      if (contractIds.length > 0) {
        await col("reminders").deleteMany({
          source_type: "contract_expiry",
          source_id: { $in: contractIds },
        });
      }
      await col("reminders").deleteMany({ document_id: id });
      await col("contracts").deleteMany({ document_id: id });
    }

    await col("documents").deleteMany({ user_id: userId, processing_status: "error" });

    console.log(`[documents] Deleted ${ids.length} corrupt documents for user ${userId}`);
    res.json({ deleted: ids.length });
  });

  // POST /api/documents/rescan — reprocess all error-status docs for the user
  app.post("/api/documents/rescan", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const errorDocs = await col("documents")
      .find({ user_id: userId, processing_status: "error" })
      .toArray();

    if (errorDocs.length === 0) {
      res.json({ queued: 0 });
      return;
    }

    for (const doc of errorDocs as any[]) {
      const id = doc._id?.toString();
      const docIdFilter = idFilter(id);

      // Wipe derived data for a clean re-process
      await col("extractions").deleteMany({ document_id: id });
      await col("tasks").deleteMany({ document_id: id });
      await col("document_clients").deleteMany({ document_id: id });
      await col("timeline_events").deleteMany({ source_type: "document", source_id: id });

      const contracts = await col("contracts").find({ document_id: id }).toArray();
      const contractIds = contracts.map((c: any) => c._id?.toString());
      if (contractIds.length > 0) {
        await col("reminders").deleteMany({
          source_type: "contract_expiry",
          source_id: { $in: contractIds },
        });
      }
      await col("reminders").deleteMany({ document_id: id });
      await col("contracts").deleteMany({ document_id: id });

      await col("documents").updateOne(docIdFilter, {
        $set: {
          processing_status: "queued",
          error_message: null,
          raw_text: null,
          document_type: null,
          document_number: null,
          updated_at: new Date(),
        },
      });

      let filePath: string;
      try {
        filePath = await resolveDocumentFilePath(doc);
      } catch (err) {
        console.error(`[rescan] doc ${id} file not accessible:`, err);
        await col("documents").updateOne(idFilter(id), {
          $set: { processing_status: "error", error_message: String(err), updated_at: new Date() },
        });
        continue;
      }
      const ext = extname(filePath);
      processDocument(id, filePath, doc.mime_type, ext, undefined, userId).catch(async (err) => {
        console.error(`[rescan] doc ${id} failed:`, err);
        await col("documents").updateOne(docIdFilter, {
          $set: { processing_status: "error", error_message: String(err), updated_at: new Date() },
        });
      });
    }

    console.log(`[documents] Queued ${errorDocs.length} documents for rescan for user ${userId}`);
    res.json({ queued: errorDocs.length });
  });

  // GET /api/documents/:id/extractions
  app.get("/api/documents/:id/extractions", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    // Verify the document belongs to the user
    const doc = await col("documents").findOne({ ...idFilter(req.params.id), user_id: userId });
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rows = await col("extractions")
      .find({ document_id: req.params.id })
      .sort({ created_at: -1 })
      .toArray();
    res.json(rows.map(flatDoc));
  });

  // POST /api/documents/:id/reprocess
  app.post("/api/documents/:id/reprocess", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const id = req.params.id;
    const filter = { ...idFilter(id), user_id: userId };

    const doc = (await col("documents").findOne(filter)) as any;
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Wipe all derived data for a clean re-process
    await col("extractions").deleteMany({ document_id: id });
    await col("tasks").deleteMany({ document_id: id });

    // Find contracts linked to this document and delete related reminders
    const contracts = await col("contracts").find({ document_id: id }).toArray();
    const contractIds = contracts.map((c: any) => c._id?.toString());
    if (contractIds.length > 0) {
      await col("reminders").deleteMany({
        source_type: "contract_expiry",
        source_id: { $in: contractIds },
      });
    }
    await col("reminders").deleteMany({ document_id: id });
    await col("contracts").deleteMany({ document_id: id });
    await col("document_clients").deleteMany({ document_id: id });
    await col("timeline_events").deleteMany({ source_type: "document", source_id: id });

    // Reset processing status
    await col("documents").updateOne(idFilter(id), {
      $set: {
        processing_status: "queued",
        error_message: null,
        raw_text: null,
        document_type: null,
        document_number: null,
        updated_at: new Date(),
      },
    });

    let filePath: string;
    try {
      filePath = await resolveDocumentFilePath(doc);
    } catch (err) {
      res.status(503).json({ error: `File not accessible: ${err}` });
      return;
    }

    const ext = extname(filePath);
    processDocument(id, filePath, doc.mime_type, ext, undefined, userId).catch(async (err) => {
      console.error(`[reprocess] doc ${id} failed:`, err);
      await col("documents").updateOne(idFilter(id), {
        $set: {
          processing_status: "error",
          error_message: String(err),
          updated_at: new Date(),
        },
      });
    });

    res.json({ ok: true });
  });
}

function idFilter(id: string): Record<string, any> {
  try {
    return { _id: new ObjectId(id) };
  } catch {
    return { _id: id };
  }
}

function flatDoc(doc: any) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

