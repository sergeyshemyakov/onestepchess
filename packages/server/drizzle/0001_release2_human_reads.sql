ALTER TABLE `players` ADD `linked_address` text;
--> statement-breakpoint
ALTER TABLE `players` ADD `linked_at` integer;
--> statement-breakpoint
CREATE INDEX `claims_player_status_moved_at` ON `claims` (`player`,`status`,`moved_at`);
--> statement-breakpoint
CREATE INDEX `games_status_finished_at` ON `games` (`status`,`finished_at`);
--> statement-breakpoint
CREATE INDEX `nickname_changes_player_changed_at` ON `nickname_changes` (`player`,`changed_at`);
