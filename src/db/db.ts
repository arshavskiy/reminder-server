import {Collection, Db, MongoClient} from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGODB_DB ?? "reminder-app";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function connectDb(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(MONGODB_URI);
  await _client.connect();
  _db = _client.db(DB_NAME);
  await ensureCollections(_db);
  await applyIndexes(_db);
  console.log(`[db] Connected to MongoDB: ${DB_NAME}`);
  return _db;
}

export function getDb(): Db {
  if (!_db) throw new Error("Database not connected. Call connectDb() first.");
  return _db;
}

export async function closeDb(): Promise<void> {
  await _client?.close();
  _client = null;
  _db = null;
}

// All collection names used by the application
const ALL_COLLECTIONS = [
  "users",
  "sessions",
  "oauth_states",
  "user_settings",
  "documents",
  "document_clients",
  "clients",
  "contracts",
  "reminders",
  "tasks",
  "extractions",
  "timeline_events",
  "email_log",
  "equipment",
  "doc_templates",
  "email_templates",
  "engineer_profiles",
  "certificates",
  "notifications",
];

async function ensureCollections(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections().toArray()).map((c) => c.name)
  );
  for (const name of ALL_COLLECTIONS) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      console.log(`[db] Created collection: ${name}`);
    }
  }
}

async function applyIndexes(db: Db): Promise<void> {
  // users
  await db.collection("users").createIndex({ google_sub: 1 }, { unique: true, sparse: true });
  await db.collection("users").createIndex({ email: 1 }, { unique: true, sparse: true });
  await db.collection("users").createIndex({ verification_token: 1 }, { sparse: true });
  await db.collection("users").createIndex({ reset_token: 1 }, { sparse: true });

  // sessions
  await db.collection("sessions").createIndex({ user_id: 1 });
  await db.collection("sessions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // oauth_states — TTL 10 minutes
  await db.collection("oauth_states").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // user_settings
  await db.collection("user_settings").createIndex({ user_id: 1 }, { unique: true, sparse: true });

  // documents — file_hash unique per user, not globally
  try { await db.collection("documents").dropIndex("file_hash_1"); } catch { /* already gone */ }
  await db.collection("documents").createIndex({ user_id: 1, file_hash: 1 }, { unique: true, sparse: true });
  await db.collection("documents").createIndex({ processing_status: 1 });
  await db.collection("documents").createIndex({ user_id: 1 });
  await db.collection("documents").createIndex({ created_at: -1 });
  await db.collection("documents").createIndex({ import_date: -1 });

  // document_clients (join collection)
  await db.collection("document_clients").createIndex({ document_id: 1 });
  await db.collection("document_clients").createIndex({ client_id: 1 });
  await db.collection("document_clients").createIndex(
    { document_id: 1, client_id: 1 },
    { unique: true }
  );

  // clients
  await db.collection("clients").createIndex({ user_id: 1 });
  await db.collection("clients").createIndex({ display_name: 1 });

  // contracts
  await db.collection("contracts").createIndex({ user_id: 1 });
  await db.collection("contracts").createIndex({ expiry_date: 1 });
  await db.collection("contracts").createIndex({ status: 1 });
  // Drop old non-unique document_id index if present, then recreate as unique+sparse
  try { await db.collection("contracts").dropIndex("document_id_1"); } catch { /* didn't exist */ }
  await db.collection("contracts").createIndex(
    { document_id: 1 },
    { unique: true, sparse: true }
  );
  await db.collection("contracts").createIndex({ client_id: 1 });

  // reminders
  await db.collection("reminders").createIndex({ user_id: 1 });
  await db.collection("reminders").createIndex({ trigger_date: 1 });
  await db.collection("reminders").createIndex({ status: 1 });
  await db.collection("reminders").createIndex({ source_type: 1, source_id: 1, advance_days: 1 });

  // tasks
  await db.collection("tasks").createIndex({ user_id: 1 });
  await db.collection("tasks").createIndex({ due_date: 1 });
  await db.collection("tasks").createIndex({ document_id: 1 });
  await db.collection("tasks").createIndex({ client_id: 1 });

  // extractions
  await db.collection("extractions").createIndex({ document_id: 1 });
  await db.collection("extractions").createIndex({ created_at: -1 });

  // timeline_events
  await db.collection("timeline_events").createIndex({ client_id: 1, event_date: -1 });
  await db.collection("timeline_events").createIndex({ user_id: 1 });

  // email_log
  await db.collection("email_log").createIndex({ user_id: 1 });
  await db.collection("email_log").createIndex({ reminder_id: 1 });
  await db.collection("email_log").createIndex({ sent_at: -1 });

  // equipment — drop old unique(name,category) if present, replace with serial_number
  try { await db.collection("equipment").dropIndex("name_1_category_1"); } catch { /* didn't exist */ }
  await db.collection("equipment").createIndex({ category: 1 });
  await db.collection("equipment").createIndex({ name: 1 });
  await db.collection("equipment").createIndex(
    { serial_number: 1 },
    { unique: true, sparse: true }
  );
  await db.collection("equipment").createIndex({ user_id: 1 });
  await db.collection("equipment").createIndex({ is_active: 1 });
  await db.collection("equipment").createIndex({ document_id: 1 });
  await db.collection("equipment").createIndex({ client_id: 1 });

  // doc_templates
  await db.collection("doc_templates").createIndex({ name: 1 }, { unique: true });
  await db.collection("doc_templates").createIndex({ is_default: 1 });

  // email_templates
  await db.collection("email_templates").createIndex({ name: 1 }, { unique: true });
  await db.collection("email_templates").createIndex({ doc_template_id: 1 });
  await db.collection("email_templates").createIndex({ is_default: 1 });

  // engineer_profiles — one per user
  await db.collection("engineer_profiles").createIndex({ user_id: 1 }, { unique: true, sparse: true });

  // certificates
  await db.collection("certificates").createIndex({ user_id: 1 });
  await db.collection("certificates").createIndex({ expiry_date: 1 });

  // notifications
  await db.collection("notifications").createIndex({ user_id: 1 });
  await db.collection("notifications").createIndex({ created_at: -1 });
  await db.collection("notifications").createIndex({ read: 1 });
}

// Typed collection helper
export function col<T extends object>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}
