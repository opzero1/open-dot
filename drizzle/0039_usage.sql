CREATE TABLE `usage_days` (
	`dot` text NOT NULL,
	`day` integer NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL,
	`input` integer DEFAULT 0 NOT NULL,
	`output` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`dot`, `day`),
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `usage_state` (
	`dot` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`cursor` text,
	`anchor` text,
	`last` text,
	`stepped` integer DEFAULT false NOT NULL,
	`counting` integer DEFAULT false NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`streak_at` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
