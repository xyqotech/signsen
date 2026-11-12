import { bigint, customType, doublePrecision, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";

// Every timestamp is an integer number of milliseconds since the epoch (UTC).
// It does not fit a 32-bit integer: bigint in PostgreSQL, a plain number in JS.
const epochMs = (name: string) => bigint(name, { mode: "number" });

/** Raw bytes; node-postgres reads and writes bytea as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const ENVELOPE_STATUSES = ["draft", "in_progress", "completed", "declined", "cancelled"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const RECIPIENT_ROLES = ["signer", "approver", "viewer"] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export const RECIPIENT_STATUSES = ["waiting", "notified", "viewed", "signed", "approved", "declined"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  locale: text("locale", { enum: ["fr", "en"] }).notNull(),
  createdAt: epochMs("created_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: epochMs("created_at").notNull(),
  expiresAt: epochMs("expires_at").notNull(),
});

/** Single-use password reset links; only the SHA-256 of the token is stored. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: epochMs("created_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

/** Content-addressed blobs; the bytes live on disk under DATA_DIR/files. */
export const files = pgTable("files", {
  sha256: text("sha256").primaryKey(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
  createdAt: epochMs("created_at").notNull(),
});

export const envelopes = pgTable(
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
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    sentAt: epochMs("sent_at"),
    completedAt: epochMs("completed_at"),
    closedAt: epochMs("closed_at"),
  },
  (t) => [index("envelopes_owner_idx").on(t.ownerId, t.updatedAt)],
);

export const recipients = pgTable(
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
    viewedAt: epochMs("viewed_at"),
    actedAt: epochMs("acted_at"),
    declineReason: text("decline_reason"),
    signatureImage: bytea("signature_image"),
    signatureKind: text("signature_kind", { enum: ["drawn", "typed"] }),
  },
  (t) => [index("recipients_envelope_idx").on(t.envelopeId, t.position)],
);

export const fields = pgTable(
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
    // Ratios of the page size, origin top-left. Double precision: the values
    // come back exactly as the editor sent them.
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    width: doublePrecision("width").notNull(),
    height: doublePrecision("height").notNull(),
  },
  (t) => [index("fields_envelope_idx").on(t.envelopeId)],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: text("id").primaryKey(),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: epochMs("created_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: epochMs("consumed_at"),
    invalidatedAt: epochMs("invalidated_at"),
  },
  (t) => [index("otp_recipient_idx").on(t.recipientId, t.createdAt)],
);

/**
 * Append-only audit trail, hash-chained per envelope. No foreign key on purpose:
 * deleting a draft must never delete its history.
 */
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    envelopeId: text("envelope_id").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    payload: text("payload").notNull(),
    createdAt: epochMs("created_at").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("events_envelope_idx").on(t.envelopeId, t.id),
    // A chain cannot fork: one successor per event, one first event per envelope.
    unique("events_chain_unique").on(t.envelopeId, t.prevHash),
  ],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: epochMs("window_start").notNull(),
  count: integer("count").notNull(),
});
