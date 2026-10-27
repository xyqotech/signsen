CREATE TABLE `envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`status` text NOT NULL,
	`document_sha256` text,
	`document_name` text,
	`page_count` integer,
	`final_sha256` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	`completed_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_sha256`) REFERENCES `files`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_sha256`) REFERENCES `files`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `envelopes_owner_idx` ON `envelopes` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`envelope_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_envelope_idx` ON `events` (`envelope_id`,`id`);--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`page` integer NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fields_envelope_idx` ON `fields` (`envelope_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `otp_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`invalidated_at` integer,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `otp_recipient_idx` ON `otp_codes` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`routing_order` integer NOT NULL,
	`status` text NOT NULL,
	`token_hash` text,
	`locale` text NOT NULL,
	`viewed_at` integer,
	`acted_at` integer,
	`decline_reason` text,
	`signature_image` blob,
	`signature_kind` text,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipients_token_hash_unique` ON `recipients` (`token_hash`);--> statement-breakpoint
CREATE INDEX `recipients_envelope_idx` ON `recipients` (`envelope_id`,`position`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`locale` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);