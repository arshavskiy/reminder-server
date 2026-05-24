import express from "express";
import {col} from "../db/db";
import {ObjectId} from "mongodb";
import type {Equipment} from "../../src/shared/types.js";
import {HTTPException, requireAuth} from "../auth/middleware";

export function registerEquipmentRoutes(app: express.Application) {
  // GET /api/equipment  — optional ?category=lift and ?q= filters
  app.get("/api/equipment", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const category = req.query.category as string | undefined;
    const search = req.query.q as string | undefined;
    const clientId = req.query.client_id as string | undefined;

    const filter: Record<string, any> = { user_id: userId };
    if (category && category !== "all") filter.category = category;
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: regex }, { manufacturer: regex }, { model: regex }];
    }

    if (clientId) {
      const docLinks = await col("document_clients").find({ client_id: clientId }).toArray() as any[];
      const docIds = docLinks.map((d: any) => String(d.document_id));
      filter.$or = [
        { client_id: clientId },
        ...(docIds.length ? [{ document_id: { $in: docIds } }] : []),
      ];
    }

    const rows = await col("equipment")
      .find(filter)
      .sort({ name: 1 })
      .toArray();

    const enriched = await Promise.all(rows.map(async (row: any) => {
      const flat = flatDoc(row) as any;
      if (row.client_id) {
        try {
          const clientOid = new ObjectId(String(row.client_id));
          const client = await col("clients").findOne({ _id: clientOid }) as any;
          flat.client_name = client?.display_name ?? null;
        } catch { flat.client_name = null; }
      }
      if (row.document_id) {
        try {
          const docOid = new ObjectId(String(row.document_id));
          const doc = await col("documents").findOne({ _id: docOid }) as any;
          flat.document_name = doc?.file_name ?? null;
        } catch { flat.document_name = null; }
      }
      return flat;
    }));

    res.json(enriched);
  });

  // GET /api/equipment/stats — count per category for the UI chips
  app.get("/api/equipment/stats", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const [counts, total] = await Promise.all([
      col("equipment")
        .aggregate([
          { $match: { is_active: 1, user_id: userId } },
          { $group: { _id: "$category", n: { $sum: 1 } } },
        ])
        .toArray(),
      col("equipment").countDocuments({ is_active: 1, user_id: userId }),
    ]);

    const map: Record<string, number> = { all: total };
    for (const c of counts as any[]) {
      map[c._id] = c.n;
    }
    res.json(map);
  });

  // GET /api/equipment/:id
  app.get("/api/equipment/:id", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const row = await col("equipment").findOne({ ...idFilter(req.params.id), user_id: userId }) as any;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const flat = flatDoc(row) as any;
    if (row.client_id) {
      try {
        const client = await col("clients").findOne({ _id: new ObjectId(String(row.client_id)) }) as any;
        flat.client_name = client?.display_name ?? null;
      } catch { flat.client_name = null; }
    }
    if (row.document_id) {
      try {
        const doc = await col("documents").findOne({ _id: new ObjectId(String(row.document_id)) }) as any;
        flat.document_name = doc?.file_name ?? null;
      } catch { flat.document_name = null; }
    }
    res.json(flat);
  });

  // POST /api/equipment
  app.post("/api/equipment", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    const body = req.body as Partial<Equipment>;
    if (!body.name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const now = new Date();
    const doc = {
      user_id: userId,
      name: body.name,
      category: body.category ?? "other",
      manufacturer: body.manufacturer ?? null,
      model: body.model ?? null,
      serial_number: body.serial_number ?? null,
      capacity: body.capacity ?? null,
      load_capacity_test: (body as any).load_capacity_test ?? null,
      load_radius: (body as any).load_radius ?? null,
      description: body.description ?? null,
      notes: body.notes ?? null,
      is_active: body.is_active ?? 1,
      created_at: now,
      updated_at: now,
    };
    const result = await col("equipment").insertOne(doc as any);
    const inserted = await col("equipment").findOne({ _id: result.insertedId });
    res.status(201).json(flatDoc(inserted));
  });

  // PUT /api/equipment/:id
  app.put("/api/equipment/:id", async (req, res) => {
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
    const body = req.body as Partial<Equipment>;

    const updates: Record<string, any> = { updated_at: new Date() };
    const fields = [
      "name", "category", "manufacturer", "model", "serial_number",
      "capacity", "load_capacity_test", "load_radius",
      "description", "notes", "is_active", "client_id",
    ];
    for (const f of fields) {
      if ((body as any)[f] !== undefined) updates[f] = (body as any)[f];
    }

    await col("equipment").updateOne(filter, { $set: updates });
    const updated = await col("equipment").findOne(filter);
    res.json(flatDoc(updated));
  });

  // DELETE /api/equipment/:id
  app.delete("/api/equipment/:id", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    await col("equipment").deleteOne({ ...idFilter(req.params.id), user_id: userId });
    res.json({ ok: true });
  });

  // POST /api/equipment/backfill — patch equipment records missing document_id/client_id
  app.post("/api/equipment/backfill", async (req, res) => {
    let userId: string;
    try {
      const ctx = await requireAuth(req.headers.cookie);
      userId = ctx.userId;
    } catch (e) {
      const err = e as HTTPException;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    let patched = 0;
    const extractions = await col("extractions").find({}).toArray();

    for (const ext of extractions as any[]) {
      let fields: any;
      try { fields = JSON.parse(ext.result_json ?? "{}"); } catch { continue; }
      const equipmentList: any[] = Array.isArray(fields._equipment) ? fields._equipment : [];
      if (!equipmentList.length) continue;

      const documentId: string = String(ext.document_id);

      // Resolve client_id: try document_clients first, fall back to contracts
      let clientId: string | null = null;
      const dc = await col("document_clients").findOne({ document_id: documentId }) as any;
      if (dc?.client_id) {
        clientId = String(dc.client_id);
      } else {
        const contract = await col("contracts").findOne({ document_id: documentId }) as any;
        if (contract?.client_id) clientId = String(contract.client_id);
      }

      for (const eq of equipmentList) {
        if (!eq?.serial_number && !eq?.name) continue;
        const matchFilter: Record<string, any> = eq.serial_number
          ? { serial_number: String(eq.serial_number).trim() }
          : { name: String(eq.name ?? "").trim() };

        const result = await col("equipment").updateOne(
          {
            ...matchFilter,
            user_id: userId,
            $or: [
              { document_id: { $exists: false } },
              { document_id: null },
              { client_id: { $exists: false } },
              { client_id: null },
            ],
          },
          {
            $set: {
              document_id: documentId,
              ...(clientId && { client_id: clientId }),
              updated_at: new Date(),
            },
          }
        );
        if (result.modifiedCount > 0) patched++;
      }
    }

    res.json({ ok: true, patched });
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
