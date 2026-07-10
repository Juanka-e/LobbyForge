CREATE TABLE IF NOT EXISTS "server_voice_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL,
  "default_user_limit" integer,
  "require_push_to_talk" boolean DEFAULT false NOT NULL,
  "start_muted" boolean DEFAULT false NOT NULL,
  "allow_camera" boolean DEFAULT true NOT NULL,
  "allow_screen_share" boolean DEFAULT true NOT NULL,
  "max_camera_users_per_room" integer,
  "max_screen_share_users_per_room" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "server_voice_settings_server_id_unique" UNIQUE("server_id"),
  CONSTRAINT "server_voice_settings_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade
);
