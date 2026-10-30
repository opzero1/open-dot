CREATE TABLE `forgotten_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`sources` text NOT NULL,
	`words` text NOT NULL,
	`fingerprint` text NOT NULL,
	`forgotten_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
