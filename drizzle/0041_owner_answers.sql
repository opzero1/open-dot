CREATE TABLE `request_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`request` integer NOT NULL,
	`actor` text NOT NULL,
	`bound_session` text NOT NULL,
	`answer` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`queued_at` integer NOT NULL,
	`attempted_at` integer,
	`confirmed_at` integer,
	FOREIGN KEY (`request`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_answers_live` ON `request_answers` (`request`) WHERE "request_answers"."state" in ('queued', 'sending', 'confirmed', 'unknown');--> statement-breakpoint
ALTER TABLE `requests` ADD `current_answer_id` text;--> statement-breakpoint
INSERT INTO `request_answers` (`id`, `request`, `actor`, `bound_session`, `answer`, `state`, `error`, `queued_at`, `attempted_at`, `confirmed_at`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`id`,
	'dot',
	`actor_session`,
	`answer`,
	CASE `state` WHEN 'queued' THEN 'queued' WHEN 'answering' THEN 'sending' WHEN 'answered' THEN 'confirmed' WHEN 'unknown' THEN 'unknown' WHEN 'stale' THEN 'stale' ELSE 'refused' END,
	CASE `state` WHEN 'stale' THEN 'legacy-stale' WHEN 'escalated' THEN 'legacy-refused' WHEN 'unknown' THEN 'legacy-unknown' ELSE NULL END,
	coalesce(`queued_at`, `created_at`),
	`attempted_at`,
	CASE `state` WHEN 'answered' THEN `confirmed_at` ELSE NULL END
FROM `requests`
WHERE `answer` IS NOT NULL AND `actor_session` IS NOT NULL;
--> statement-breakpoint
UPDATE `requests` SET `current_answer_id` = (SELECT `id` FROM `request_answers` WHERE `request_answers`.`request` = `requests`.`id`)
WHERE `answer` IS NOT NULL AND `actor_session` IS NOT NULL;
