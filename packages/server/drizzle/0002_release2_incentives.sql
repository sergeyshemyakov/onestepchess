ALTER TABLE `players` ADD `ref_code` text;--> statement-breakpoint
ALTER TABLE `players` ADD `referred_by` text;--> statement-breakpoint
ALTER TABLE `players` ADD `referral_awarded_at` integer;--> statement-breakpoint
ALTER TABLE `players` ADD `ref_joined` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `ref_qualified` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `players_ref_code` ON `players` (`ref_code`);--> statement-breakpoint
CREATE TABLE `point_awards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`player`) REFERENCES `players`(`address`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `point_awards_player_reason_ref` ON `point_awards` (`player`,`reason`,`ref_id`);
