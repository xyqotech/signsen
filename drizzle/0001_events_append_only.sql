-- The audit trail is append-only: the database itself refuses edits, deletions
-- and truncation of "events", whoever asks.
CREATE FUNCTION "events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "events_no_update" BEFORE UPDATE ON "events"
FOR EACH ROW EXECUTE FUNCTION "events_append_only"();
--> statement-breakpoint
CREATE TRIGGER "events_no_delete" BEFORE DELETE ON "events"
FOR EACH ROW EXECUTE FUNCTION "events_append_only"();
--> statement-breakpoint
CREATE TRIGGER "events_no_truncate" BEFORE TRUNCATE ON "events"
FOR EACH STATEMENT EXECUTE FUNCTION "events_append_only"();
