CREATE INDEX `claims_created_at` ON `claims` (`created_at`);--> statement-breakpoint
CREATE INDEX `claims_status_moved_at` ON `claims` (`status`,`moved_at`);--> statement-breakpoint
CREATE INDEX `stake_entries_created_at` ON `stake_entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_ts` ON `ledger` (`ts`);--> statement-breakpoint
CREATE INDEX `games_resolved_at` ON `games` (`resolved_at`);--> statement-breakpoint
CREATE INDEX `payout_jobs_status_created_at` ON `payout_jobs` (`status`,`created_at`);--> statement-breakpoint
DELETE FROM `config_overrides` WHERE `key` = 'ADMIN_CACHE_TTL_SECONDS';
