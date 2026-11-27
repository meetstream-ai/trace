CREATE TABLE `meetstream_bots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`request_id` text,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`stop_requested_at` integer,
	`meeting_id` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meetstream_bot_request` ON `meetstream_bots` (`workspace`,`request_id`);