import express from "express";
import {col} from "../db/db";
import {requireAuth} from "../auth/middleware";
import {getSettings} from "../settings";

export function registerUserSettingsRoutes(app: express.Application) {
  app.get("/api/user-settings", async (req, res) => {
    let auth;
    try {
      auth = await requireAuth(req.headers.cookie ?? undefined);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const row = await col("user_settings").findOne({ user_id: auth.userId });
    if (!row) {
      const defaults = {
        user_id: auth.userId,
        theme: "light",
        email_from_name: null,
        reminder_advance_days: "[90,60,30]",
        ocr_language: "heb+eng",
        scanned_count: 0,
        document_limit: getSettings().userDocumentLimit,  // per-user override, defaults to env
      };
      await col("user_settings").updateOne(
        { user_id: auth.userId },
        { $setOnInsert: defaults },
        { upsert: true }
      );
      res.json(defaults);
      return;
    }
    const { _id, ...rest } = row as any;
    const scanned_count: number = rest.scanned_count ?? 0;
    const document_limit: number = rest.document_limit ?? getSettings().userDocumentLimit;
    res.json({ id: _id?.toString(), ...rest, scanned_count, document_limit });
  });

  app.put("/api/user-settings", async (req, res) => {
    let auth;
    try {
      auth = await requireAuth(req.headers.cookie ?? undefined);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body as {
      theme?: string;
      email_from_name?: string;
      reminder_advance_days?: string;
      ocr_language?: string;
      document_limit?: number;
    };

    const patch: Record<string, unknown> = {};
    if (body.theme !== undefined)                  patch.theme = body.theme;
    if (body.email_from_name !== undefined)        patch.email_from_name = body.email_from_name ?? null;
    if (body.reminder_advance_days !== undefined)  patch.reminder_advance_days = body.reminder_advance_days;
    if (body.ocr_language !== undefined)           patch.ocr_language = body.ocr_language;
    if (body.document_limit !== undefined)         patch.document_limit = body.document_limit;

    await col("user_settings").updateOne(
      { user_id: auth.userId },
      {
        $set: patch,
        $setOnInsert: { user_id: auth.userId },
      },
      { upsert: true }
    );

    const row = await col("user_settings").findOne({ user_id: auth.userId });
    const { _id, ...rest } = (row ?? {}) as any;
    res.json({ id: _id?.toString(), ...rest });
  });
}
