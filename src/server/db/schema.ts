import { blob, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Every timestamp is an integer number of milliseconds since the epoch (UTC).

export const ENVELOPE_STATUSES = ["draft", "in_progress", "completed", "declined", "cancelled"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const RECIPIENT_ROLES = ["signer", "approver", "viewer"] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export const RECIPIENT_STATUSES = ["waiting", "notified", "viewed", "signed", "approved", "declined"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  locale: text("locale", { enum: ["fr", "en"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Content-addressed blobs; the bytes live on disk under DATA_DIR/files. */
export const files = sqliteTable("files", {
  sha256: text("sha256").primaryKey(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const envelopes = sqliteTable(
  "envelopes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    message: text("message"),
    status: text("status", { enum: ENVELOPE_STATUSES }).notNull(),
    documentSha256: text("document_sha256").references(() => files.sha256),
    documentName: text("document_name"),
    pageCount: integer("page_count"),
    finalSha256: text("final_sha256").references(() => files.sha256),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    sentAt: integer("sent_at"),
    completedAt: integer("completed_at"),
    closedAt: integer("closed_at"),
  },
  (t) => [index("envelopes_owner_idx").on(t.ownerId, t.updatedAt)],
);

export const recipients = sqliteTable(
  "recipients",
  {
    id: text("id").primaryKey(),
    envelopeId: text("envelope_id")
      .notNull()
      .references(() => envelopes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: RECIPIENT_ROLES }).notNull(),
    routingOrder: integer("routing_order").notNull(),
    status: text("status", { enum: RECIPIENT_STATUSES }).notNull(),
    tokenHash: text("token_hash").unique(),
    locale: text("locale", { enum: ["fr", "en"] }).notNull(),
    viewedAt: integer("viewed_at"),
    actedAt: integer("acted_at"),
    declineReason: text("decline_reason"),
    signatureImage: blob("signature_image", { mode: "buffer" }),
    signatureKind: text("signature_kind", { enum: ["drawn", "typed"] }),
  },
  (t) => [index("recipients_envelope_idx").on(t.envelopeId, t.position)],
);

export const fields = sqliteTable(
  "fields",
  {
    id: text("id").primaryKey(),
    envelopeId: text("envelope_id")
      .notNull()
      .references(() => envelopes.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    page: integer("page").notNull(), // 1-based
    x: real("x").notNull(), // ratios of the page size, origin top-left
    y: real("y").notNull(),
    width: real("width").notNull(),
    height: real("height").notNull(),
  },
  (t) => [index("fields_envelope_idx").on(t.envelopeId)],
);

export const otpCodes = sqliteTable(
  "otp_codes",
  {
    id: text("id").primaryKey(),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: integer("consumed_at"),
    invalidatedAt: integer("invalidated_at"),
  },
  (t) => [index("otp_recipient_idx").on(t.recipientId, t.createdAt)],
);

/**
 * Append-only audit trail, hash-chained per envelope. No foreign key on purpose:
 * deleting a draft must never delete its history.
 */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    envelopeId: text("envelope_id").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("events_envelope_idx").on(t.envelopeId, t.id)],
);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});
