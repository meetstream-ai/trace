ALTER TABLE `deliveries` ADD `followup_of` text;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `followup_date` text;--> statement-breakpoint
CREATE INDEX `delivery_followup` ON `deliveries` (`owner`,`followup_of`);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `linear_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_linear_key` ON `deliveries` (`owner`,`issue_target`,`linear_key`);
