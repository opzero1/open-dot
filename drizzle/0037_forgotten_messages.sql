CREATE TABLE `forgotten_messages` (
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`forgotten_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forgotten_messages_dot_session_id_message_id_unique` ON `forgotten_messages` (`dot`,`session_id`,`message_id`);