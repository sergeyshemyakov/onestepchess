CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_nonces` (
	`address` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`arc60_data_b64` text NOT NULL,
	`fallback_unsigned_b64` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`player` text NOT NULL,
	`side` text NOT NULL,
	`demo` integer DEFAULT false NOT NULL,
	`stake_microusdc` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`deadline` integer NOT NULL,
	`moved_at` integer,
	`moved_ply` integer,
	`move_uci` text,
	`move_san` text,
	`fen_after` text,
	`nudge_due_at` integer,
	`nudge_sent_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_open_game` ON `claims` (`game_id`) WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `claims_open_player` ON `claims` (`player`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `claims_player_created` ON `claims` (`player`,`created_at`);--> statement-breakpoint
CREATE TABLE `config_overrides` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `error_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`request_id` text,
	`context_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`player` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`fen` text NOT NULL,
	`ply` integer DEFAULT 0 NOT NULL,
	`history_json` text DEFAULT '[]' NOT NULL,
	`rules_json` text NOT NULL,
	`result` text,
	`termination` text,
	`endspiel_ply` integer,
	`replay_json` text,
	`min_next_claim_at` integer DEFAULT 0 NOT NULL,
	`last_ply_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_name_unique` ON `games` (`name`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`account` text NOT NULL,
	`delta_microusdc` integer NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`txid` text
);
--> statement-breakpoint
CREATE TABLE `ledger_balances` (
	`account` text PRIMARY KEY NOT NULL,
	`balance_microusdc` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nickname_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player` text NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`player` text NOT NULL,
	`move_uci` text NOT NULL,
	`amount` integer NOT NULL,
	`client_txid` text NOT NULL,
	`status` text NOT NULL,
	`last_valid_round` integer,
	`settle_txid` text,
	`payment_response_header` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_client_txid_unique` ON `payment_intents` (`client_txid`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_in_flight` ON `payment_intents` (`claim_id`) WHERE status IN ('verified', 'settling');--> statement-breakpoint
CREATE TABLE `payout_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`payload_b64` text NOT NULL,
	`group_id` text NOT NULL,
	`last_valid_round` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payout_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`recipient` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`batch_id` text,
	`txid` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `payout_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_jobs_game_recipient` ON `payout_jobs` (`game_id`,`recipient`);--> statement-breakpoint
CREATE TABLE `players` (
	`address` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`nickname` text,
	`created_at` integer NOT NULL,
	`turnstile_verified_at` integer,
	`abandon_count` integer DEFAULT 0 NOT NULL,
	`deprioritized_until` integer,
	`wins` integer DEFAULT 0 NOT NULL,
	`draws` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`quota_override` integer,
	`banned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_nickname_nocase` ON `players` ("nickname" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `revoked_jti` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stake_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`player` text NOT NULL,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`pay_txid` text NOT NULL,
	`ply` integer NOT NULL,
	`payout_amount` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stake_entries_claim_id_unique` ON `stake_entries` (`claim_id`);--> statement-breakpoint
CREATE INDEX `stake_entries_game` ON `stake_entries` (`game_id`);--> statement-breakpoint
CREATE INDEX `stake_entries_player` ON `stake_entries` (`player`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`rail_kind` text NOT NULL,
	`caip2` text NOT NULL,
	`usdc_asset` text NOT NULL,
	`treasury_address` text NOT NULL,
	`pause_causes_json` text DEFAULT '[]' NOT NULL,
	`banner` text,
	`config_revision` integer DEFAULT 0 NOT NULL,
	`last_reconcile_at` integer,
	`last_reconcile_json` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "system_state_singleton" CHECK("system_state"."id" = 1)
);
