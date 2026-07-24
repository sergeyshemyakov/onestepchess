ALTER TABLE `claims` ADD `fen_before` text;
--> statement-breakpoint
UPDATE `claims`
SET `fen_before` = CASE
  WHEN `moved_ply` = 1
    THEN 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  ELSE (
    SELECT `prior`.`fen_after`
    FROM `claims` AS `prior`
    WHERE `prior`.`game_id` = `claims`.`game_id`
      AND `prior`.`moved_ply` = `claims`.`moved_ply` - 1
  )
END
WHERE `status` = 'moved';
--> statement-breakpoint
UPDATE `claims`
SET `fen_before` = (
  SELECT `games`.`fen`
  FROM `games`
  WHERE `games`.`id` = `claims`.`game_id`
)
WHERE `status` = 'open';
