CREATE TABLE `direct_stakes` (
	`txid` text PRIMARY KEY NOT NULL,
	`player` text NOT NULL,
	`claim_id` text NOT NULL,
	`amount` integer NOT NULL,
	`outcome` text NOT NULL,
	`confirmed_round` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `direct_stakes_claim` ON `direct_stakes` (`claim_id`);--> statement-breakpoint
CREATE INDEX `stake_entries_pay_txid` ON `stake_entries` (`pay_txid`);
