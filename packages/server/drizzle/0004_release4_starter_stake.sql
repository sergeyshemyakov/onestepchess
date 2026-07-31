CREATE TABLE `bonuses` (
	`player` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'claimed' NOT NULL,
	`algo_amount` integer NOT NULL,
	`usdc_amount` integer NOT NULL,
	`claim_ip` text NOT NULL,
	`algo_txid` text,
	`usdc_txid` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claimed_at` integer NOT NULL,
	`opted_in_at` integer,
	`funded_at` integer,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `bonuses_status` CHECK(`status` IN ('claimed', 'opted_in', 'funded')),
	CONSTRAINT `bonuses_amounts` CHECK(`algo_amount` > 0 AND `usdc_amount` > 0)
);
--> statement-breakpoint
CREATE INDEX `bonuses_claimed_at` ON `bonuses` (`claimed_at`);
--> statement-breakpoint
CREATE TABLE `funding_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`player` text NOT NULL,
	`leg` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload_b64` text,
	`txid` text,
	`last_valid_round` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `funding_jobs_leg` CHECK(`leg` IN ('algo', 'usdc')),
	CONSTRAINT `funding_jobs_status` CHECK(`status` IN ('pending', 'prepared', 'submitted', 'confirmed', 'failed')),
	CONSTRAINT `funding_jobs_amount` CHECK(`amount` > 0),
	CONSTRAINT `funding_jobs_prepared_shape` CHECK(
		(`status` IN ('pending', 'failed') AND (`payload_b64` IS NULL OR (`txid` IS NOT NULL AND `last_valid_round` IS NOT NULL))) OR
		(`status` IN ('prepared', 'submitted', 'confirmed') AND `payload_b64` IS NOT NULL AND `txid` IS NOT NULL AND `last_valid_round` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funding_jobs_player_leg` ON `funding_jobs` (`player`,`leg`);
