ALTER TABLE "roles" ADD COLUMN "icon" varchar(32);--> statement-breakpoint
ALTER TABLE "server_voice_settings" ADD COLUMN "max_screen_share_height" integer DEFAULT 1080 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_voice_settings" ADD COLUMN "max_screen_share_fps" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" varchar(190);
ALTER TABLE "roles" ADD CONSTRAINT "roles_icon_allowlist_check" CHECK (
  "icon" IS NULL OR "icon" IN ('shield', 'verified', 'star', 'crown', 'sports_esports', 'music_note', 'groups', 'palette')
);--> statement-breakpoint
ALTER TABLE "server_voice_settings" ADD CONSTRAINT "server_voice_settings_share_height_check" CHECK (
  "max_screen_share_height" IN (480, 720, 1080, 1440, 2160)
);--> statement-breakpoint
ALTER TABLE "server_voice_settings" ADD CONSTRAINT "server_voice_settings_share_fps_check" CHECK (
  "max_screen_share_fps" IN (15, 30, 60)
);
