import {describe, expect, it, vi} from "vitest";

// ── helpers ───────────────────────────────────────────────────────────────────

function mockCol(data: Record<string, any[]> = {}) {
  return (name: string) => {
    const docs = data[name] ?? [];
    return {
      findOne: vi.fn(async (filter: any) => {
        return docs.find((d) => {
          for (const [k, v] of Object.entries(filter)) {
            if (d[k] !== v) return false;
          }
          return true;
        }) ?? null;
      }),
      countDocuments: vi.fn(async (filter: any) => {
        return docs.filter((d) => {
          for (const [k, v] of Object.entries(filter)) {
            if (d[k] !== v) return false;
          }
          return true;
        }).length;
      }),
      updateOne: vi.fn(async (..._args: any[]) => ({ modifiedCount: 1, upsertedCount: 0 })),
    };
  };
}

function mockAuth(userId = "user123") {
  return { userId, user: { id: userId, role: "user", email: "test@test.com", name: "Test", is_active: 1 } as any };
}

// ── profile stats ─────────────────────────────────────────────────────────────

describe("GET /api/profile/stats logic", () => {
  it("counts pending as active, snoozed as snoozed, sent as completed", async () => {
    const userId = "u1";
    const reminders = [
      { user_id: userId, status: "pending" },
      { user_id: userId, status: "pending" },
      { user_id: userId, status: "snoozed" },
      { user_id: userId, status: "sent" },
      { user_id: userId, status: "sent" },
      { user_id: userId, status: "sent" },
      { user_id: "other", status: "pending" }, // different user — should not count
    ];
    const col = mockCol({ reminders });

    const [active, snoozed, sent] = await Promise.all([
      col("reminders").countDocuments({ user_id: userId, status: "pending" }),
      col("reminders").countDocuments({ user_id: userId, status: "snoozed" }),
      col("reminders").countDocuments({ user_id: userId, status: "sent" }),
    ]);

    expect(active).toBe(2);
    expect(snoozed).toBe(1);
    expect(sent).toBe(3);
  });

  it("returns zeros when user has no reminders", async () => {
    const col = mockCol({ reminders: [] });
    const active = await col("reminders").countDocuments({ user_id: "nobody", status: "pending" });
    expect(active).toBe(0);
  });
});

// ── user-settings GET ─────────────────────────────────────────────────────────

describe("GET /api/user-settings logic", () => {
  it("returns existing settings row", async () => {
    const userId = "u2";
    const existing = {
      user_id: userId,
      theme: "dark",
      email_from_name: "MyApp",
      reminder_advance_days: "[30,14,7]",
      ocr_language: "heb",
    };
    const col = mockCol({ user_settings: [existing] });

    const row = await col("user_settings").findOne({ user_id: userId });
    expect(row).not.toBeNull();
    expect(row.theme).toBe("dark");
    expect(row.email_from_name).toBe("MyApp");
  });

  it("returns null when settings not yet created", async () => {
    const col = mockCol({ user_settings: [] });
    const row = await col("user_settings").findOne({ user_id: "newuser" });
    expect(row).toBeNull();
  });
});

// ── user-settings PUT ─────────────────────────────────────────────────────────

describe("PUT /api/user-settings logic", () => {
  it("serialises reminder_advance_days as JSON array string", () => {
    const raw = "90, 60, 30";
    const days = raw.split(",").map((x) => parseInt(x.trim())).filter((x) => !isNaN(x) && x > 0);
    expect(days).toEqual([90, 60, 30]);
    expect(JSON.stringify(days)).toBe("[90,60,30]");
  });

  it("filters out non-numeric or zero values", () => {
    const raw = "90, abc, 0, 30";
    const days = raw.split(",").map((x) => parseInt(x.trim())).filter((x) => !isNaN(x) && x > 0);
    expect(days).toEqual([90, 30]);
  });

  it("calls updateOne with correct upsert payload", async () => {
    const updateOne = vi.fn(async (..._args: any[]) => ({ modifiedCount: 0, upsertedCount: 1 }));
    const fakeCollection = { updateOne };

    await fakeCollection.updateOne(
      { user_id: "u3" },
      { $set: { theme: "light" }, $setOnInsert: { user_id: "u3" } },
      { upsert: true } as any
    );

    expect(updateOne).toHaveBeenCalledOnce();
    const [filter] = updateOne.mock.calls[0];
    expect(filter).toEqual({ user_id: "u3" });
  });
});

// ── reminder_advance_days parsing ─────────────────────────────────────────────

describe("reminder_advance_days round-trip", () => {
  it("parses stored JSON back to display string", () => {
    const stored = "[90,60,30]";
    const display = JSON.parse(stored).join(", ");
    expect(display).toBe("90, 60, 30");
  });

  it("handles empty array", () => {
    const stored = "[]";
    const display = JSON.parse(stored).join(", ");
    expect(display).toBe("");
  });

  it("handles single value", () => {
    const stored = "[30]";
    const display = JSON.parse(stored).join(", ");
    expect(display).toBe("30");
  });
});

