-- Instance logo: shown in the lobby header (next to the instance name)
-- and reused as the favicon. Image data URL, validated at upload time
-- (content-sniffed format + dimensions, GIF included).
ALTER TABLE "instance_settings" ADD COLUMN "instance_logo_url" text;
