CREATE TABLE `__new_bonuses` (
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
	`opt_in_deadline_at` integer NOT NULL,
	`algo_skipped_at` integer,
	`opted_in_at` integer,
	`funded_at` integer,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `bonuses_status` CHECK(`status` IN ('claimed', 'opted_in', 'funded', 'expired')),
	CONSTRAINT `bonuses_amounts` CHECK(`algo_amount` > 0 AND `usdc_amount` > 0)
);
--> statement-breakpoint
INSERT INTO `__new_bonuses` (`player`, `status`, `algo_amount`, `usdc_amount`, `claim_ip`, `algo_txid`, `usdc_txid`, `attempts`, `next_attempt_at`, `claimed_at`, `opt_in_deadline_at`, `algo_skipped_at`, `opted_in_at`, `funded_at`)
SELECT `player`, `status`, `algo_amount`, `usdc_amount`, `claim_ip`, `algo_txid`, `usdc_txid`, `attempts`, `next_attempt_at`, `claimed_at`, `claimed_at` + 86400000, NULL, `opted_in_at`, `funded_at` FROM `bonuses`;
--> statement-breakpoint
DROP TABLE `bonuses`;
--> statement-breakpoint
ALTER TABLE `__new_bonuses` RENAME TO `bonuses`;
--> statement-breakpoint
CREATE INDEX `bonuses_claimed_at` ON `bonuses` (`claimed_at`);
