'use client';

import { useRef, useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface ChangeAvatarModalProps {
  open: boolean;
  onClose: () => void;
  currentAvatarUrl: string | null;
  displayName: string;
  /** Persist the cropped image. Implementation can upload + PATCH user. */
  onSave: (input: { file: File; croppedDataUrl: string }) => Promise<void>;
}

export function ChangeAvatarModal({
  open,
  onClose,
  currentAvatarUrl,
  displayName,
  onSave,
}: ChangeAvatarModalProps) {
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
      setError('Image is larger than 5 MB. Choose a smaller file.');
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
      const dataUrl = await renderCroppedDataUrl(previewUrl, zoom, rotation);
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
      title="Change Avatar"
      description="Upload and adjust your community profile image."
      size="lg"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!file} loading={saving}>
            Save Avatar
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="w-full aspect-square max-h-[360px] bg-surface-dim rounded-xl overflow-hidden relative border border-border-subtle">
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
              aria-label="Avatar preview"
            />
          ) : currentAvatarUrl ? (
            <div
              className="absolute inset-0 w-full h-full bg-cover bg-center"
              style={{ backgroundImage: `url(${currentAvatarUrl})` }}
              aria-label={`${displayName} avatar`}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-text-muted text-6xl font-medium">
              {displayName.trim().charAt(0).toUpperCase() || '?'}
            </div>
          )}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-[280px] h-[280px] max-w-[80%] max-h-[80%] aspect-square rounded-full border border-primary/30 shadow-[0_0_0_9999px_rgba(17,23,34,0.85)] mix-blend-hard-light relative">
              <div className="absolute inset-0 border border-white/10 rounded-full border-dashed" />
            </div>
          </div>
        </div>

        {previewUrl ? (
          <div className="flex items-center justify-between bg-surface-dim p-4 rounded-xl border border-border-subtle">
            <div className="flex items-center gap-3 flex-1 max-w-[240px]">
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
            <p className="text-xs text-text-muted">PNG, JPG or WebP · Maximum 5 MB</p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="w-16 h-16 rounded-full overflow-hidden border border-border-strong bg-surface">
              {previewUrl ? (
                <div
                  className="w-full h-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${previewUrl})` }}
                  aria-label="Avatar preview"
                />
              ) : currentAvatarUrl ? (
                <img
                  src={currentAvatarUrl}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-text-muted text-xl font-medium">
                  {displayName.trim().charAt(0).toUpperCase() || '?'}
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

async function renderCroppedDataUrl(
  sourceUrl: string,
  zoom: number,
  rotation: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }
        const baseScale = Math.max(size / image.width, size / image.height);
        const scale = baseScale * (zoom / 100);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const offsetX = (size - drawWidth) / 2;
        const offsetY = (size - drawHeight) / 2;
        ctx.fillStyle = '#101419';
        ctx.fillRect(0, 0, size, size);
        ctx.translate(size / 2, size / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-size / 2, -size / 2);
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
