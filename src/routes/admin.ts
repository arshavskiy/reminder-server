import express from "express";
import {ObjectId} from "mongodb";
import {col} from "../db/db";
import {requireAuth, requireRole} from "../auth/middleware";
import type {UserRole} from "../../src/shared/types.js";

const VALID_ROLES: UserRole[] = ["admin", "pro", "user"];

function flatUser(doc: any) {
  if (!doc) return doc;
  const { _id, password_hash, verification_token, reset_token, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

export function registerAdminRoutes(app: express.Application) {
  // All /api/admin/* routes require admin role
  async function adminAuth(req: express.Request, res: express.Response) {
    try {
      const auth = await requireAuth(req.headers.cookie ?? undefined);
      requireRole(auth, "admin");
      return auth;
    } catch (err: any) {
      res.status(err.status ?? 403).json({ error: err.message });
      return null;
    }
  }

  // GET /api/admin/users — list all users with their quota info
  app.get("/api/admin/users", async (req, res) => {
    if (!await adminAuth(req, res)) return;

    const [users, settings] = await Promise.all([
      col("users").find({}).sort({ created_at: -1 }).toArray(),
      col("user_settings").find({}).toArray(),
    ]);

    const settingsMap = new Map(
      (settings as any[]).map((s) => [s.user_id, s])
    );

    res.json(users.map((u: any) => {
      const us = settingsMap.get(u._id.toString()) as any;
      return {
        ...flatUser(u),
        scanned_count: us?.scanned_count ?? 0,
        document_limit: us?.document_limit ?? null,
      };
    }));
  });

  // PUT /api/admin/users/:id — update role / is_active
  app.put("/api/admin/users/:id", async (req, res) => {
    const auth = await adminAuth(req, res);
    if (!auth) return;

    const { role, is_active } = req.body as { role?: string; is_active?: number };

    const updates: Record<string, any> = { updated_at: new Date() };

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role as UserRole)) {
        res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
        return;
      }
      updates.role = role;
    }

    if (is_active !== undefined) {
      updates.is_active = is_active ? 1 : 0;
    }

    let filter: Record<string, any>;
    try {
      filter = { _id: new ObjectId(req.params.id) };
    } catch {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    // Prevent admin from demoting themselves
    if (role && role !== "admin" && req.params.id === auth.userId) {
      res.status(400).json({ error: "Cannot change your own role" });
      return;
    }

    await col("users").updateOne(filter, { $set: updates });
    const updated = await col("users").findOne(filter);
    res.json(flatUser(updated));
  });

  // PUT /api/admin/users/:id/document-limit — set per-user document limit
  app.put("/api/admin/users/:id/document-limit", async (req, res) => {
    if (!await adminAuth(req, res)) return;

    const { limit } = req.body as { limit: number };
    if (typeof limit !== "number" || limit < 0) {
      res.status(400).json({ error: "limit must be a non-negative number" });
      return;
    }

    let userId: string;
    try {
      userId = new ObjectId(req.params.id).toString();
    } catch {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    // Verify user exists
    const user = await col("users").findOne({ _id: new ObjectId(req.params.id) });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await col("user_settings").updateOne(
      { user_id: userId },
      { $set: { document_limit: limit }, $setOnInsert: { user_id: userId, scanned_count: 0 } },
      { upsert: true }
    );

    res.json({ userId, document_limit: limit });
  });

  // GET /api/admin/settings — protected settings (same as /api/settings but explicit admin check)
  app.get("/api/admin/settings", async (req, res) => {
    if (!await adminAuth(req, res)) return;
    res.json({ allowed: true });
  });
}
