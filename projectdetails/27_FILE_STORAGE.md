# 27 — File Storage & Upload Strategy

## Overview

LobbyForge needs file storage for user avatars, server icons, message attachments, plugin assets (Hushle card images, etc.), and potential future media. This document defines the storage architecture, upload pipeline, and security constraints.

## Storage Architecture

### MVP: Local Filesystem

```
/data/uploads/
  avatars/
    {userId}/avatar.webp
  servers/
    {serverId}/icon.webp
  attachments/
    {channelId}/{year}/{month}/{attachmentId}/{filename}
  plugins/
    {pluginId}/assets/
```

- Served via Nginx `location /uploads/ { alias /data/uploads/; }` with caching headers
- Docker volume mount: `./data/uploads:/data/uploads`
- Included in backup.sh (`tar` the uploads directory)

### Future: S3-Compatible Storage

When scaling beyond single VPS or when CDN is needed:
- **Self-hosted:** MinIO container in Docker Compose
- **Cloud:** Cloudflare R2 (no egress fees), AWS S3, Backblaze B2
- Abstraction interface:

```ts
interface StorageProvider {
  upload(bucket: string, key: string, stream: ReadableStream, metadata: FileMetadata): Promise<StorageResult>;
  getUrl(bucket: string, key: string): string;
  delete(bucket: string, key: string): Promise<void>;
  exists(bucket: string, key: string): Promise<boolean>;
}

// Implementations:
// LocalStorageProvider (MVP)
// S3StorageProvider (future)
```

## Upload Pipeline

### Flow

```
Client selects file
  → Client-side validation (size, type, dimensions)
  → POST /api/upload (multipart/form-data)
  → Server-side validation
  → Virus scan (future: ClamAV)
  → Image processing (resize, compress, strip EXIF)
  → Write to storage
  → Insert attachment record in PostgreSQL
  → Return URL
```

### Image Processing

- Library: **sharp** (Node.js, fast, WebAssembly fallback)
- Avatar: resize to 256x256, convert to WebP, quality 80
- Server icon: resize to 512x512, convert to WebP, quality 80
- Message attachments: keep original + generate thumbnail (200x200)
- Strip all EXIF/metadata for privacy

## File Constraints

| Type | Max Size | Allowed MIME Types | Max Dimensions |
|---|---|---|---|
| Avatar | 5 MB | image/jpeg, image/png, image/webp, image/gif | 4096x4096 |
| Server Icon | 5 MB | image/jpeg, image/png, image/webp, image/gif | 4096x4096 |
| Message Attachment (image) | 25 MB | image/jpeg, image/png, image/webp, image/gif | 8192x8192 |
| Message Attachment (video) | 100 MB | video/mp4, video/webm | — |
| Message Attachment (file) | 50 MB | application/pdf, text/plain, application/zip + more | — |
| Plugin Asset | 10 MB | varies per plugin | — |

## Security

- **Never serve uploads from the app domain.** Use a separate subdomain or path (`uploads.example.com` or `app.example.com/uploads/`) with restricted headers.
- **Content-Type validation:** Check magic bytes, not just extension.
- **Content-Disposition:** Always `attachment` for non-image files to prevent XSS.
- **No executable files:** Block `.exe`, `.sh`, `.bat`, `.js`, `.html`, `.svg` (SVG can contain JS).
- **Rate limiting:** Max 10 uploads per minute per user.
- **Disk quota (future):** Per-server upload quota (e.g., 1 GB free, more with config).

## Cleanup

- Orphaned files (no DB reference): weekly cleanup cron
- Deleted message attachments: mark deleted, purge after 30 days
- Old avatar versions: overwrite (single file per user)

## CDN Strategy (Future)

- Nginx caching layer with `proxy_cache` for uploads
- Optional Cloudflare/CDN proxy for `/uploads/` path
- Cache-Control: `public, max-age=31536000, immutable` for attachment UUIDs
- Cache-Control: `public, max-age=3600` for avatars (can change)

## Backup

- `backup.sh` includes uploads directory in tar archive
- For S3 storage: bucket versioning + cross-region replication
- Large upload directories: incremental backup with rsync
