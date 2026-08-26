ALTER TABLE `claims` ADD COLUMN `expiring_notified_at` integer;
--> statement-breakpoint
UPDATE `claims` SET `expiring_notified_at` = (
	SELECT `e`.`ts` FROM `events` `e`
	WHERE `e`.`type` = 'claim_expiring'
		AND `e`.`player` = `claims`.`player`
		AND `e`.`payload_json` LIKE '%"claimId":"' || `claims`.`id` || '"%'
	ORDER BY `e`.`ts` LIMIT 1
) WHERE `status` = 'open';
--> statement-breakpoint
CREATE INDEX `events_ts` ON `events` (`ts`);
