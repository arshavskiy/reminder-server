import {copyFileSync, existsSync, mkdirSync, readFileSync, statSync} from "fs";
import {createHash} from "crypto";
import {basename, extname, join} from "path";
import {col} from "../db/db";
import {ObjectId} from "mongodb";
import {getDataDir, getSettings} from "../settings";
import {parsePdf} from "./pdfParser";
import {ocrFile} from "./ocrParser";
import {parseDocx} from "./docxParser";
import {parseXlsx} from "./xlsxParser";
import {extractDocument, extractWithTemplate} from "./extractor";
import {pickTemplate} from "../templates/seedTemplates";
import {generateContractReminders} from "../reminders/scheduler";
import {spacesEnabled, uploadToSpaces} from "../storage/spaces";
import type {DocTemplate, DynamicExtraction} from "../../src/shared/types.js";

type PushFn = (event: Record<string, unknown>) => void;

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".md": "text/markdown",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function computeHash(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export interface ImportResult {
  id: string;
  duplicate: boolean;
  fileName: string;
}

export async function importFile(originalPath: string, push?: PushFn, userId?: string, displayName?: string): Promise<ImportResult> {
  const settings = getSettings();

  const ext = extname(originalPath);
  const fileName = displayName ?? basename(originalPath);
  const fileHash = computeHash(originalPath);
  const fileSize = statSync(originalPath).size;
  const mimeType = getMimeType(ext);

  // Dedup check — scoped to user if provided
  const dedupFilter: Record<string, any> = { file_hash: fileHash };
  if (userId) dedupFilter.user_id = userId;
  const existing = await col("documents").findOne(dedupFilter);
  if (existing) {
    console.log(`[importer] Skipping duplicate: ${fileName}`);
    return { id: existing._id!.toString(), duplicate: true, fileName };
  }

  // Copy to managed documents folder (skipped when SAVE_FILE=false)
  let managedPath: string | null = null;
  let spacesKey: string | null = null;
  let spacesUrl: string | null = null;

  if (!settings.processOnly) {
    const docsDir = join(getDataDir(), "documents");
    mkdirSync(docsDir, { recursive: true });
    managedPath = join(docsDir, `${fileHash}${ext}`);
    if (!existsSync(managedPath)) {
      copyFileSync(originalPath, managedPath);
    }
    console.log(`[importer] Local copy: ${managedPath}`);

    if (spacesEnabled()) {
      try {
        spacesKey = `documents/${fileHash}${ext}`;
        spacesUrl = await uploadToSpaces(managedPath, spacesKey, mimeType);
        console.log(`[importer] S3 upload: ${spacesKey} → ${spacesUrl}`);
      } catch (err) {
        console.error(`[importer] Object storage upload failed, keeping local copy:`, err);
        spacesKey = null;
        spacesUrl = null;
      }
    } else {
      console.log(`[importer] Object storage not configured — local only`);
    }
  } else {
    console.log(`[importer] PROCESS_ONLY=true — skipping local copy and S3 upload`);
  }

  const now = new Date();
  const docRecord: Record<string, any> = {
    file_name: fileName,
    file_path: managedPath,
    original_path: originalPath,
    file_hash: fileHash,
    mime_type: mimeType,
    file_size_bytes: fileSize,
    import_date: now,
    processing_status: "queued",
    created_at: now,
    updated_at: now,
    spaces_key: spacesKey,
    spaces_url: spacesUrl,
  };
  if (userId) docRecord.user_id = userId;

  const insertResult = await col("documents").insertOne(docRecord);
  const documentId = insertResult.insertedId.toString();

  push?.({ type: "document:queued", documentId: documentId as any, fileName });
  console.log(`[importer] Queued document ${documentId}: ${fileName}`);

  processDocument(documentId, managedPath ?? originalPath, mimeType, ext, push, userId).catch(async (err) => {
    console.error(`[importer] Fatal error processing doc ${documentId}:`, err);
    await col("documents").updateOne(
      { _id: insertResult.insertedId },
      { $set: { processing_status: "error", error_message: String(err), updated_at: new Date() } }
    );
    push?.({ type: "document:done", documentId: documentId as any, status: "error", error: String(err) });
  });

  return { id: documentId, duplicate: false, fileName };
}

export async function processDocument(
  documentId: string,
  filePath: string,
  mimeType: string,
  ext: string,
  push?: PushFn,
  userId?: string
) {
  const settings = getSettings();
  const docFilter = { _id: new ObjectId(documentId) } as any;

  await col("documents").updateOne(docFilter, {
    $set: { processing_status: "processing", updated_at: new Date() },
  });
  push?.({ type: "document:progress", documentId: documentId as any, stage: "extracting_text", progress: 10 });

  let rawText = "";
  let pageCount: number | null = null;

  try {
    if (mimeType === "application/pdf") {
      const pdfResult = await parsePdf(filePath);
      pageCount = pdfResult.pageCount;
      if (pdfResult.needsOcr) {
        push?.({ type: "document:progress", documentId: documentId as any, stage: "ocr", progress: 25 });
        rawText = await ocrFile(filePath);
      } else {
        rawText = pdfResult.text;
      }
    } else if (mimeType.startsWith("image/")) {
      push?.({ type: "document:progress", documentId: documentId as any, stage: "ocr", progress: 25 });
      rawText = await ocrFile(filePath);
    } else if (ext === ".docx") {
      rawText = await parseDocx(filePath);
    } else if (ext === ".xlsx") {
      rawText = parseXlsx(filePath);
    } else {
      rawText = readFileSync(filePath, "utf-8");
    }
  } catch (err) {
    const msg = `Text extraction failed: ${err}`;
    await col("documents").updateOne(docFilter, {
      $set: { processing_status: "error", error_message: msg, updated_at: new Date() },
    });
    push?.({ type: "document:done", documentId: documentId as any, status: "error", error: msg });
    return;
  }

  await col("documents").updateOne(docFilter, {
    $set: { raw_text: rawText, page_count: pageCount, processing_status: "processing", updated_at: new Date() },
  });

  push?.({ type: "document:progress", documentId: documentId as any, stage: "ai_extraction", progress: 50 });

  if (settings.autoExtract && rawText.trim().length > 0) {
    const docRow = await col("documents").findOne(docFilter) as any;

    const template = await pickTemplate(rawText);

    if (template) {
      const run = await extractWithTemplate(rawText, template, documentId, docRow?.file_name);

      await col("extractions").insertOne({
        document_id: documentId,
        backend: run.backend,
        model: run.model,
        result_json: run.rawJson,
        raw_text: rawText,
        parsed_ok: run.fields ? 1 : 0,
        error: run.error ?? null,
        exec_ms: run.execMs,
        created_at: new Date(),
      } as any);

      if (run.fields) {
        await col("documents").updateOne(docFilter, {
          $set: {
            extracted_fields: JSON.stringify(run.fields),
            template_id: template.id,
            document_type: template.name,
            updated_at: new Date(),
          },
        });

        push?.({ type: "document:progress", documentId: documentId as any, stage: "saving_entities", progress: 75 });
        await saveTemplateEntities(documentId, template, run.fields, userId);
      } else if (run.error) {
        const msg = `AI extraction failed: ${run.error}`;
        await col("documents").updateOne(docFilter, {
          $set: { processing_status: "error", error_message: msg, updated_at: new Date() },
        });
        push?.({ type: "document:done", documentId: documentId as any, status: "error", error: msg });
        console.error(`[importer] ${msg}`);
        return;
      }
    } else {
      const extraction = await extractDocument(rawText, documentId, docRow?.file_name);
      await col("extractions").insertOne({
        document_id: documentId,
        backend: extraction.backend,
        model: extraction.model,
        result_json: extraction.rawJson,
        raw_text: rawText,
        parsed_ok: extraction.result ? 1 : 0,
        error: extraction.error ?? null,
        exec_ms: extraction.execMs,
        created_at: new Date(),
      } as any);

      if (extraction.result) {
        push?.({ type: "document:progress", documentId: documentId as any, stage: "saving_entities", progress: 75 });
        await saveExtractionEntities(documentId, extraction.result, userId);
      } else if (extraction.error) {
        const msg = `AI extraction failed: ${extraction.error}`;
        await col("documents").updateOne(docFilter, {
          $set: { processing_status: "error", error_message: msg, updated_at: new Date() },
        });
        push?.({ type: "document:done", documentId: documentId as any, status: "error", error: msg });
        return;
      }
    }
  }

  await col("documents").updateOne(docFilter, {
    $set: { processing_status: "done", updated_at: new Date() },
  });

  if (userId) {
    await col("user_settings").updateOne(
      { user_id: userId },
      { $inc: { scanned_count: 1 }, $setOnInsert: { user_id: userId } },
      { upsert: true }
    );
  }

  push?.({ type: "document:done", documentId: documentId as any, status: "done" });
  console.log(`[importer] Done processing document ${documentId}`);
}

async function saveExtractionEntities(
  documentId: string,
  result: import("../../src/shared/types.js").ExtractionResult,
  userId?: string
) {
  if (result.document_type || result.document_number) {
    await col("documents").updateOne(
      { _id: new ObjectId(documentId) } as any,
      {
        $set: {
          ...(result.document_type && { document_type: result.document_type }),
          ...(result.document_number && { document_number: result.document_number }),
          updated_at: new Date(),
        },
      }
    );
  }

  let clientId: string | null = null;
  const displayName = result.client_company ?? result.client_name;
  const entityType: "company" | "person" = result.client_company ? "company" : "person";

  if (displayName) {
    const contactNote =
      result.client_company && result.client_name
        ? `איש קשר: ${result.client_name}`
        : null;

    clientId = await findOrCreateClient({
      displayName,
      entityType,
      idNumber: result.client_id ?? null,
      email: result.client_email ?? null,
      phone: result.client_phone ?? null,
      address: result.client_address ?? null,
      notes: contactNote,
      userId,
    });

    await col("document_clients").updateOne(
      { document_id: documentId, client_id: clientId },
      { $setOnInsert: { document_id: documentId, client_id: clientId, role: "party_a" } },
      { upsert: true }
    );

    await col("timeline_events").insertOne({
      client_id: clientId,
      event_type: "document_added",
      title: result.document_type ? `${result.document_type} יובא` : "מסמך חדש יובא",
      description: result.summary_hebrew ?? null,
      event_date: new Date(),
      source_id: documentId,
      source_type: "document",
      created_at: new Date(),
    } as any);
  }

  if (result.expiry_date || result.start_date || result.contract_number || result.document_number) {
    const contractFields = {
      ...(userId && { user_id: userId }),
      client_id: clientId,
      contract_number: result.contract_number ?? result.document_number ?? null,
      contract_type: result.contract_type ?? result.document_type ?? null,
      start_date: result.start_date ?? null,
      expiry_date: result.expiry_date ?? null,
      amount: result.amount ?? null,
      currency: result.currency ?? "ILS",
      counterparty:
        (result.parties ?? [])
          .filter((p) => p !== (result.client_company ?? result.client_name))
          .join(", ") || null,
      summary: result.summary_hebrew ?? null,
      confidence: result.confidence ?? "medium",
      updated_at: new Date(),
    };
    const upsertResult = await col("contracts").findOneAndUpdate(
      { document_id: documentId },
      {
        $set: contractFields,
        $setOnInsert: { document_id: documentId, status: "active", created_at: new Date() },
      },
      { upsert: true, returnDocument: "after" }
    );
    const contractId = (upsertResult as any)?._id?.toString() ?? documentId;
    if (result.expiry_date) {
      await generateContractReminders(contractId, clientId, documentId, result.expiry_date, userId);
    }
  }

  for (const task of result.tasks ?? []) {
    await col("tasks").insertOne({
      ...(userId && { user_id: userId }),
      document_id: documentId,
      client_id: clientId,
      description: task.description,
      due_date: task.due_date ?? null,
      status: "pending",
      created_at: new Date(),
      updated_at: new Date(),
    } as any);
  }
}

async function saveTemplateEntities(
  documentId: string,
  template: DocTemplate,
  fields: DynamicExtraction,
  userId?: string
) {
  const f = fields;

  const getStr = (k: string): string | null => {
    const v = f[k];
    if (v === undefined || v === null || v === "") return null;
    return String(v);
  };
  const getNum = (k: string): number | null => {
    const v = f[k];
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };

  const clientCompany = getStr("client_company");
  const contactPerson = getStr("contact_person") ?? getStr("client_name");
  const displayName = clientCompany ?? contactPerson;
  const entityType: "company" | "person" = clientCompany ? "company" : "person";

  let clientId: string | null = null;
  if (displayName) {
    const contactNote =
      clientCompany && contactPerson ? `איש קשר: ${contactPerson}` : null;

    clientId = await findOrCreateClient({
      displayName,
      entityType,
      idNumber: getStr("client_id"),
      email: getStr("contact_email"),
      phone: getStr("contact_phone"),
      address: getStr("client_address"),
      notes: contactNote,
      userId,
    });

    await col("document_clients").updateOne(
      { document_id: documentId, client_id: clientId },
      { $setOnInsert: { document_id: documentId, client_id: clientId, role: "party_a" } },
      { upsert: true }
    );

    await col("timeline_events").insertOne({
      client_id: clientId,
      event_type: "document_added",
      title: `${template.name} יובא`,
      description: null,
      event_date: new Date(),
      source_id: documentId,
      source_type: "document",
      created_at: new Date(),
    } as any);
  }

  const docNumber =
    getStr("contract_number") ?? getStr("report_number") ?? getStr("invoice_number");
  const startDate =
    getStr("start_date") ?? getStr("inspection_date") ?? getStr("issue_date");
  const expiryDate = template.expiry_field ? getStr(template.expiry_field) : null;

  if (docNumber || startDate || expiryDate) {
    const contractFields = {
      ...(userId && { user_id: userId }),
      client_id: clientId,
      contract_number: docNumber,
      contract_type: template.name,
      start_date: startDate,
      expiry_date: expiryDate,
      amount: getNum("amount"),
      currency: getStr("currency") ?? "ILS",
      summary: getStr("findings") ?? getStr("notes") ?? getStr("summary_hebrew"),
      confidence: (getStr("_confidence") as "high" | "medium" | "low") ?? "medium",
      updated_at: new Date(),
    };
    const upsertResult = await col("contracts").findOneAndUpdate(
      { document_id: documentId },
      {
        $set: contractFields,
        $setOnInsert: { document_id: documentId, status: "active", created_at: new Date() },
      },
      { upsert: true, returnDocument: "after" }
    );
    const contractId = (upsertResult as any)?._id?.toString() ?? documentId;
    if (expiryDate) {
      await generateContractReminders(contractId, clientId, documentId, expiryDate, userId);
    }
  }

  // Save equipment items extracted from inspection reports
  const equipmentList = Array.isArray(f["_equipment"]) ? f["_equipment"] as any[] : [];
  for (const eq of equipmentList) {
    if (!eq || typeof eq !== "object") continue;
    const name: string = (eq.name ?? eq.description ?? "").trim();
    if (!name) continue;

    // Match by serial_number if present (most reliable), otherwise by name
    const matchFilter: Record<string, any> = eq.serial_number
      ? { serial_number: String(eq.serial_number).trim() }
      : { name };

    const now = new Date();
    await col("equipment").updateOne(
      matchFilter,
      {
        $set: {
          name,
          category: eq.category ?? "other",
          ...(eq.manufacturer != null && { manufacturer: String(eq.manufacturer) }),
          ...(eq.model != null && { model: String(eq.model) }),
          ...(eq.serial_number != null && { serial_number: String(eq.serial_number).trim() }),
          ...(eq.load_capacity_work != null && { capacity: String(eq.load_capacity_work) }),
          ...(eq.load_capacity_test != null && { load_capacity_test: String(eq.load_capacity_test) }),
          ...(eq.load_radius != null && { load_radius: String(eq.load_radius) }),
          document_id: documentId,
          ...(clientId != null && { client_id: clientId }),
          ...(userId && { user_id: userId }),
          updated_at: now,
        },
        $setOnInsert: {
          description: null,
          notes: null,
          is_active: 1,
          created_at: now,
        },
      },
      { upsert: true }
    );

    console.log(`[importer] Equipment upserted: ${name} | SN: ${eq.serial_number ?? "—"} | ${eq.manufacturer ?? "?"} ${eq.model ?? ""}`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalise a company/person name for fuzzy dedup:
// lower-case, collapse whitespace, strip common legal suffixes and punctuation
function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/["""''`״׳]/g, '"')   // normalise quote chars
    .replace(/בע"מ|בע''מ|בעמ|ltd\.?|inc\.?|llc\.?/gi, "")
    .replace(/[^\p{L}\p{N}]/gu, " ")  // non-letter/digit → space
    .replace(/\s+/g, " ")
    .trim();
}

interface ClientInput {
  displayName: string;
  entityType: "company" | "person";
  idNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  userId?: string;
}

/**
 * Find an existing client by id_number, phone, or normalised name — in that
 * priority order — then merge any new fields into it.  If no match is found,
 * insert a new client.  Returns the client's _id as a string.
 */
async function findOrCreateClient(input: ClientInput): Promise<string> {
  const { displayName, entityType, idNumber, email, phone, address, notes, userId } = input;
  const userScope = userId ? { user_id: userId } : {};

  let existing: any = null;

  // 1. Strongest signal: government-issued id / company registration number
  if (idNumber) {
    existing = await col("clients").findOne({ ...userScope, id_number: idNumber }) as any;
    if (existing) console.log(`[importer] Client matched by id_number: ${idNumber}`);
  }

  // 2. Phone (normalised — strip spaces and dashes)
  if (!existing && phone) {
    const normPhone = phone.replace(/[\s\-]/g, "");
    existing = await col("clients").findOne({
      ...userScope,
      phone: { $regex: new RegExp(escapeRegex(normPhone)) },
    }) as any;
    if (existing) console.log(`[importer] Client matched by phone: ${phone}`);
  }

  // 3. Exact name match (case-insensitive)
  if (!existing) {
    existing = await col("clients").findOne({
      ...userScope,
      display_name: { $regex: new RegExp(`^${escapeRegex(displayName)}$`, "i") },
    }) as any;
    if (existing) console.log(`[importer] Client matched by exact name: ${displayName}`);
  }

  // 4. Normalised name match (strips bע"מ / punctuation)
  if (!existing) {
    const norm = normaliseName(displayName);
    if (norm.length >= 3) {
      const all = await col("clients").find(userScope).toArray() as any[];
      existing = all.find((c: any) => normaliseName(c.display_name ?? "") === norm) ?? null;
      if (existing) console.log(`[importer] Client matched by normalised name: "${norm}"`);
    }
  }

  if (existing) {
    const clientId = existing._id.toString();
    const mergedNotes =
      notes && !(existing.notes ?? "").includes(notes)
        ? [existing.notes, notes].filter(Boolean).join("\n")
        : existing.notes;

    await col("clients").updateOne(
      { _id: existing._id },
      {
        $set: {
          ...(email && !existing.email && { email }),
          ...(phone && !existing.phone && { phone }),
          ...(address && !existing.address && { address }),
          ...(idNumber && !existing.id_number && { id_number: idNumber }),
          ...(mergedNotes !== existing.notes && { notes: mergedNotes }),
          updated_at: new Date(),
        },
      }
    );
    return clientId;
  }

  // No match — create new
  const r = await col("clients").insertOne({
    ...userScope,
    display_name: displayName,
    entity_type: entityType,
    id_number: idNumber ?? null,
    email: email ?? null,
    phone: phone ?? null,
    address: address ?? null,
    notes: notes ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  } as any);
  console.log(`[importer] Client created: ${displayName}`);
  return r.insertedId.toString();
}

