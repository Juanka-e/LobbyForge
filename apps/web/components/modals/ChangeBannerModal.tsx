'use client';

import { useRef, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

/**
 * Change Banner modal — the wide (3:1) sibling of `ChangeAvatarModal`.
 *
 * Same canonical pattern: file picker → live preview with zoom + rotate
 * → canvas crops to the canonical banner size on save. The host caller
 * receives the cropped data URL and persists it (typically PATCH on the
 * community / user profile).
 *
 * Stitch reference: design_stitch/lobbyforge_change_banner_modal_overlay
 * (the folder is currently empty — design intent inferred from the
 * avatar modal + the standard 3:1 community banner used in the lobby
 * sidebar header).
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Canonical banner dimensions. 3:1 aspect matches the community header
// tile rendered in the sidebar's top button. Keep in sync with the
// server-side validator.
const BANNER_WIDTH = 1200;
const BANNER_HEIGHT = 400;

export interface ChangeBannerModalProps {
  open: boolean;
  onClose: () => void;
  currentBannerUrl: string | null;
  /** Display name used as aria label fallback + initial-letter placeholder. */
  communityName: string;
  /** Persist the cropped banner. Implementation can upload + PATCH server/user. */
  onSave: (input: { file: File; croppedDataUrl: string }) => Promise<void>;
}

export function ChangeBannerModal({
  open,
  onClose,
  currentBannerUrl,
  communityName,
  onSave,
}: ChangeBannerModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickFile(selected: File) {
    setError(null);
    if (!ACCEPTED.includes(selected.type)) {
      setError('Please choose a PNG, JPG, WebP, or GIF image.');
      return;
    }
    if (selected.size > MAX_FILE_BYTES) {
      setError('Image is larger than 8 MB. Choose a smaller file.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(selected);
    setFile(selected);
    setPreviewUrl(url);
    setZoom(100);
    setRotation(0);
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setZoom(100);
    setRotation(0);
    setError(null);
  }

  function close() {
    if (saving) return;
    reset();
    onClose();
  }

  async function save() {
    if (!file || !previewUrl) return;
    setSaving(true);
    setError(null);
    try {
      const dataUrl = await renderCroppedBanner(previewUrl, zoom, rotation);
      await onSave({ file, croppedDataUrl: dataUrl });
      reset();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Change Banner"
      description="Upload and adjust your community's wide header image."
      size="xl"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!file} loading={saving}>
            Save Banner
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div
          className="w-full bg-surface-dim rounded-xl overflow-hidden relative border border-border-subtle"
          style={{ aspectRatio: '3 / 1', maxHeight: 360 }}
        >
          {previewUrl ? (
            <div
              className="absolute inset-0 w-full h-full"
              style={{
                backgroundImage: `url(${previewUrl})`,
                backgroundSize: `${zoom + 10}%`,
                backgroundPosition: 'center',
                transform: `rotate(${rotation}deg)`,
                backgroundRepeat: 'no-repeat',
              }}
              aria-label="Banner preview"
            />
          ) : currentBannerUrl ? (
            <div
              className="absolute inset-0 w-full h-full bg-cover bg-center"
              style={{ backgroundImage: `url(${currentBannerUrl})` }}
              aria-label={`${communityName} banner`}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm uppercase tracking-widest">
              No banner set
            </div>
          )}
        </div>

        {previewUrl ? (
          <div className="flex items-center justify-between bg-surface-dim p-4 rounded-xl border border-border-subtle">
            <div className="flex items-center gap-3 flex-1 max-w-[280px]">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => setZoom((value) => Math.max(50, value - 10))}
                className="text-text-muted hover:text-text-primary"
              >
                <span className="material-symbols-outlined text-[20px]">remove</span>
              </button>
              <input
                type="range"
                min={50}
                max={200}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="flex-1 accent-primary"
                aria-label="Zoom level"
              />
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => setZoom((value) => Math.min(200, value + 10))}
                className="text-text-muted hover:text-text-primary"
              >
                <span className="material-symbols-outlined text-[20px]">add</span>
              </button>
            </div>
            <div className="flex items-center gap-2 border-l border-border-subtle pl-4 ml-4">
              <button
                type="button"
                aria-label="Rotate left"
                onClick={() => setRotation((value) => value - 90)}
                className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-variant rounded-lg"
              >
                <span className="material-symbols-outlined text-[20px]">rotate_left</span>
              </button>
              <button
                type="button"
                aria-label="Rotate right"
                onClick={() => setRotation((value) => value + 90)}
                className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-variant rounded-lg"
              >
                <span className="material-symbols-outlined text-[20px]">rotate_right</span>
              </button>
              <div className="w-px h-6 bg-border-subtle mx-2" />
              <button
                type="button"
                onClick={() => {
                  setZoom(100);
                  setRotation(0);
                }}
                className="text-sm text-text-muted hover:text-text-primary px-2 py-1"
              >
                Reset
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED.join(',')}
              className="sr-only"
              onChange={(event) => {
                const next = event.target.files?.[0];
                if (next) pickFile(next);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-surface-variant border border-border-strong text-text-secondary hover:text-text-primary hover:border-text-muted rounded-lg transition-colors w-fit text-sm font-medium"
            >
              <span className="material-symbols-outlined text-[18px]">upload</span>
              {previewUrl ? 'Choose Another Image' : 'Choose Image'}
            </button>
            <p className="text-xs text-text-muted">
              PNG, JPG or WebP · Maximum 8 MB · Recommended 1200×400
            </p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div
              className="rounded-md overflow-hidden border border-border-strong bg-surface"
              style={{ width: 120, height: 40 }}
            >
              {previewUrl ? (
                <div
                  className="w-full h-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${previewUrl})` }}
                  aria-label="Banner preview"
                />
              ) : currentBannerUrl ? (
                <img
                  src={currentBannerUrl}
                  alt={`${communityName} banner`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-text-muted text-[10px] uppercase tracking-widest">
                  No banner
                </div>
              )}
            </div>
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Preview</span>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

async function renderCroppedBanner(
  sourceUrl: string,
  zoom: number,
  rotation: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = BANNER_WIDTH;
        canvas.height = BANNER_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }
        const baseScale = Math.max(
          BANNER_WIDTH / image.width,
          BANNER_HEIGHT / image.height
        );
        const scale = baseScale * (zoom / 100);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const offsetX = (BANNER_WIDTH - drawWidth) / 2;
        const offsetY = (BANNER_HEIGHT - drawHeight) / 2;
        ctx.fillStyle = '#101419';
        ctx.fillRect(0, 0, BANNER_WIDTH, BANNER_HEIGHT);
        ctx.translate(BANNER_WIDTH / 2, BANNER_HEIGHT / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-BANNER_WIDTH / 2, -BANNER_HEIGHT / 2);
        ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err as Error);
      }
    };
    image.onerror = () => reject(new Error('Failed to read image'));
    image.src = sourceUrl;
  });
}
