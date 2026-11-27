CREATE TABLE `integration_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`destination` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_owner` ON `integration_settings` (`owner`,`destination`);--> statement-breakpoint
CREATE TABLE `login_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`owner` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires` integer NOT NULL
);
