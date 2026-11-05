CREATE TABLE `tree_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`run` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`query_hash` text NOT NULL,
	`day` integer NOT NULL,
	`created_at` integer NOT NULL,
	`baseline` text NOT NULL,
	`tree` text NOT NULL,
	`metrics` text NOT NULL,
	`review` text,
	`reviewed_at` integer,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tree_samples_day` ON `tree_samples` (`dot`,`run`,`day`);--> statement-breakpoint
CREATE UNIQUE INDEX `tree_samples_dot_run_message_id_unique` ON `tree_samples` (`dot`,`run`,`message_id`);--> statement-breakpoint
CREATE TABLE `tree_trials` (
	`dot` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`run` text NOT NULL,
	`version` text NOT NULL,
	`baseline` text NOT NULL,
	`session_id` text NOT NULL,
	`settings` text NOT NULL,
	`started_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
