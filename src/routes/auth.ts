import express from "express";
import {col} from "../db/db";
import {getSettings} from "../settings";
import {
    exchangeCodeForIdToken,
    generateCodeVerifier,
    generateState,
    getGoogleAuthUrl,
    verifyIdToken,
} from "../auth/google";
import {createSession, extractSessionFromCookie, revokeSession, verifySession,} from "../auth/session";
import {
    generateToken,
    hashPassword,
    sendPasswordResetEmail,
    sendVerificationEmail,
    verifyPassword,
} from "../auth/emailAuth";

export function registerAuthRoutes(app: express.Application) {
  // GET /auth/google — kick off OAuth flow
  app.get("/auth/google", async (req, res) => {
    const settings = getSettings();
    if (!settings.googleClientId || !settings.googleClientSecret) {
      res.status(503).send("Google OAuth not configured");
      return;
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();

    // Persist PKCE state to DB so a server restart between redirect and callback
    // doesn't lose it
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await col("oauth_states").insertOne({
      state,
      code_verifier: codeVerifier,
      expires_at: expiresAt,
    } as any);

    // Prune expired states
    await col("oauth_states").deleteMany({ expires_at: { $lt: new Date() } });

    const url = await getGoogleAuthUrl(state, codeVerifier);
    res.redirect(url);
  });

  // GET /auth/google/callback — handle redirect from Google
  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.redirect(frontendUrl(`/#/login?error=${encodeURIComponent(error)}`));
      return;
    }

    if (!code || !state) {
      res.redirect(frontendUrl("/#/login?error=missing_params"));
      return;
    }

    const pkce = await col<{ state: string; code_verifier: string; expires_at: Date }>(
      "oauth_states"
    ).findOne({ state, expires_at: { $gt: new Date() } });

    if (!pkce) {
      res.redirect(frontendUrl("/#/login?error=invalid_state"));
      return;
    }
    await col("oauth_states").deleteOne({ state });

    try {
      const tokens = await exchangeCodeForIdToken(code, pkce.code_verifier);
      const profile = await verifyIdToken(tokens.id_token);
      const settings = getSettings();

      // Email whitelist check
      if (settings.allowedEmails && settings.allowedEmails.length > 0) {
        if (!settings.allowedEmails.includes(profile.email)) {
          res.redirect(frontendUrl("/#/login?error=not_allowed"));
          return;
        }
      }

      // Upsert user
      await col("users").updateOne(
        { google_sub: profile.sub },
        {
          $set: {
            email: profile.email,
            name: profile.name ?? null,
            picture_url: profile.picture ?? null,
            last_login_at: new Date(),
          },
          $setOnInsert: {
            google_sub: profile.sub,
            role: "user",
            is_active: 1,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      const user = await col("users").findOne({ google_sub: profile.sub }) as any;
      if (!user) throw new Error("User not found after upsert");

      // Ensure user_settings row exists
      await col("user_settings").updateOne(
        { user_id: user._id.toString() },
        {
          $setOnInsert: {
            user_id: user._id.toString(),
            theme: "light",
            email_from_name: null,
            reminder_advance_days: "[90,60,30]",
            ocr_language: "heb+eng",
            scanned_count: 0,
            document_limit: getSettings().userDocumentLimit,
          },
        },
        { upsert: true }
      );

      const ua = req.headers["user-agent"] ?? undefined;
      const ip = (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress ?? undefined;
      const { cookies } = await createSession(user._id.toString(), ua, ip);

      res.setHeader("Set-Cookie", cookies);
      res.redirect(frontendUrl("/"));
    } catch (err) {
      console.error("[auth] OAuth callback error:", err);
      res.redirect(frontendUrl("/#/login?error=auth_failed"));
    }
  });

  // POST /api/auth/google — GIS credential (ID token) sign-in
  app.post("/api/auth/google", async (req, res) => {
    const body = req.body as { credential?: string };
    if (!body.credential) {
      res.status(400).json({ error: "missing_credential" });
      return;
    }

    try {
      const profile = await verifyIdToken(body.credential);
      const settings = getSettings();

      if (settings.allowedEmails && settings.allowedEmails.length > 0) {
        if (!settings.allowedEmails.includes(profile.email)) {
          res.status(403).json({ error: "not_allowed" });
          return;
        }
      }

      // Upsert user
      await col("users").updateOne(
        { google_sub: profile.sub },
        {
          $set: {
            email: profile.email,
            name: profile.name ?? null,
            picture_url: profile.picture ?? null,
            last_login_at: new Date(),
          },
          $setOnInsert: {
            google_sub: profile.sub,
            role: "user",
            is_active: 1,
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      const user = await col("users").findOne({ google_sub: profile.sub }) as any;
      if (!user) throw new Error("User not found after upsert");

      // Ensure user_settings row exists
      await col("user_settings").updateOne(
        { user_id: user._id.toString() },
        {
          $setOnInsert: {
            user_id: user._id.toString(),
            theme: "light",
            email_from_name: null,
            reminder_advance_days: "[90,60,30]",
            ocr_language: "heb+eng",
            scanned_count: 0,
            document_limit: getSettings().userDocumentLimit,
          },
        },
        { upsert: true }
      );

      const ua = req.headers["user-agent"] ?? undefined;
      const ip = (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress ?? undefined;
      const { cookies } = await createSession(user._id.toString(), ua, ip);

      res.setHeader("Set-Cookie", cookies);
      res.status(200).json({
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          picture_url: user.picture_url,
          role: user.role,
        },
      });
    } catch (err) {
      console.error("[auth] GIS sign-in error:", err);
      res.status(500).json({ error: "auth_failed" });
    }
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", async (req, res) => {
    const cookieHeader = req.headers.cookie ?? undefined;
    const sessionId = extractSessionFromCookie(cookieHeader);
    if (sessionId) {
      await revokeSession(sessionId);
    }
    res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    res.json({ ok: true });
  });

  // GET /api/auth/me — return current user info
  app.get("/api/auth/me", async (req, res) => {
    const cookieHeader = req.headers.cookie ?? undefined;
    const sessionId = extractSessionFromCookie(cookieHeader);
    if (!sessionId) {
      res.json({ user: null });
      return;
    }

    const user = await verifySession(sessionId);
    if (!user) {
      res.json({ user: null });
      return;
    }

    res.json({
      user: {
        id: (user as any).id,
        email: user.email,
        name: user.name,
        phone: (user as any).phone ?? null,
        picture_url: user.picture_url,
        role: user.role,
      },
    });
  });

  // POST /api/auth/register — email/password registration
  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name } = req.body as { email?: string; password?: string; name?: string };

    if (!email || !password) {
      res.status(400).json({ error: "email_and_password_required" });
      return;
    }

    const emailLower = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      res.status(400).json({ error: "invalid_email" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }

    const settings = getSettings();
    if (settings.allowedEmails && settings.allowedEmails.length > 0) {
      if (!settings.allowedEmails.includes(emailLower)) {
        res.status(403).json({ error: "not_allowed" });
        return;
      }
    }

    const existing = await col("users").findOne({ email: emailLower });
    if (existing) {
      res.status(409).json({ error: "email_taken" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const verificationToken = generateToken();
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await col("users").insertOne({
      email: emailLower,
      name: name?.trim() ?? null,
      picture_url: null,
      google_sub: null,
      password_hash: passwordHash,
      email_verified: 0,
      verification_token: verificationToken,
      verification_token_expires: tokenExpiry,
      role: "user",
      is_active: 1,
      created_at: new Date(),
      last_login_at: null,
    } as any);

    const base = serverBaseUrl(req);
    try {
      await sendVerificationEmail(emailLower, verificationToken, base);
    } catch (err) {
      console.error("[auth] Failed to send verification email:", err);
    }

    res.status(201).json({ ok: true, emailSent: true });
  });

  // POST /api/auth/login — email/password sign-in
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: "email_and_password_required" });
      return;
    }

    const emailLower = email.trim().toLowerCase();
    const user = await col("users").findOne({ email: emailLower }) as any;

    if (!user || !user.password_hash) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    if (!user.email_verified) {
      res.status(403).json({ error: "email_not_verified" });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: "account_disabled" });
      return;
    }

    await col("users").updateOne({ _id: user._id }, { $set: { last_login_at: new Date() } });

    const ua = req.headers["user-agent"] ?? undefined;
    const ip = (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress ?? undefined;
    const { cookies } = await createSession(user._id.toString(), ua, ip);

    res.setHeader("Set-Cookie", cookies);
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        picture_url: user.picture_url,
        role: user.role,
      },
    });
  });

  // GET /auth/verify-email?token=...
  app.get("/auth/verify-email", async (req, res) => {
    const token = req.query.token as string | undefined;
    if (!token) {
      res.redirect(frontendUrl("/#/login?error=invalid_token"));
      return;
    }

    const user = await col("users").findOne({
      verification_token: token,
      verification_token_expires: { $gt: new Date() },
    }) as any;

    if (!user) {
      res.redirect(frontendUrl("/#/login?error=token_expired"));
      return;
    }

    await col("users").updateOne(
      { _id: user._id },
      {
        $set: { email_verified: 1, updated_at: new Date() },
        $unset: { verification_token: "", verification_token_expires: "" },
      }
    );

    // Auto sign-in after verification
    const ua = req.headers["user-agent"] ?? undefined;
    const ip = (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress ?? undefined;
    const { cookies } = await createSession(user._id.toString(), ua, ip);
    res.setHeader("Set-Cookie", cookies);
    res.redirect(frontendUrl("/?verified=1"));
  });

  // POST /api/auth/forgot-password
  app.post("/api/auth/forgot-password", async (req, res) => {
    const { email } = req.body as { email?: string };
    if (!email) {
      res.status(400).json({ error: "email_required" });
      return;
    }

    const emailLower = email.trim().toLowerCase();
    const user = await col("users").findOne({ email: emailLower }) as any;

    // Always return ok to avoid user enumeration
    if (!user || !user.password_hash) {
      res.json({ ok: true });
      return;
    }

    const resetToken = generateToken();
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000);

    await col("users").updateOne(
      { _id: user._id },
      { $set: { reset_token: resetToken, reset_token_expires: resetExpiry } }
    );

    const base = serverBaseUrl(req);
    try {
      await sendPasswordResetEmail(emailLower, resetToken, base);
    } catch (err) {
      console.error("[auth] Failed to send reset email:", err);
    }

    res.json({ ok: true });
  });

  // POST /api/auth/reset-password
  app.post("/api/auth/reset-password", async (req, res) => {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!token || !password) {
      res.status(400).json({ error: "token_and_password_required" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }

    const user = await col("users").findOne({
      reset_token: token,
      reset_token_expires: { $gt: new Date() },
    }) as any;

    if (!user) {
      res.status(400).json({ error: "invalid_or_expired_token" });
      return;
    }

    const passwordHash = await hashPassword(password);
    await col("users").updateOne(
      { _id: user._id },
      {
        $set: { password_hash: passwordHash, email_verified: 1, updated_at: new Date() },
        $unset: { reset_token: "", reset_token_expires: "" },
      }
    );

    res.json({ ok: true });
  });
}

const DEV_FRONTEND =
  process.env.VITE_DEV_URL ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173");

function frontendUrl(path: string): string {
  return `${DEV_FRONTEND}${path}`;
}

function serverBaseUrl(req: express.Request): string {
  if (process.env.SERVER_URL) return process.env.SERVER_URL;
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}
