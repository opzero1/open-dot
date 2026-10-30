CREATE TABLE `owner_fact_keys` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`fact` text NOT NULL,
	PRIMARY KEY(`kind`, `key`),
	FOREIGN KEY (`fact`) REFERENCES `owner_facts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `owner_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`text` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`origin_dot` text,
	`origin_session` text,
	`origin_message` text,
	`last_mutation_id` text
);
