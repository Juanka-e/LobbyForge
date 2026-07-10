'use client';

import { useEffect, useRef, useState } from 'react';
import { useLobbyVoice, type LobbyVoiceParticipant } from './LobbyVoiceProvider';

/**
 * M21.4d - Full-screen voice/video view (Discord "Stage View" equivalent).
 *
 * When the user toggles to voice mode from the channel header, this
 * replaces the normal chat area. It shows:
 *   - A large pinned tile for screen share / focused speaker
 *   - A responsive grid of participant camera tiles
 *   - A compact chat sidebar on the right (so the user can still type)
 *
 * A "Back to Chat" button in the top-left restores the normal text
 * channel view.
 */
export function LobbyVoiceView(_props: { channelId: string; channelName: string }) {
  const voice = useLobbyVoice();
  const [focusedIdentity, setFocusedIdentity] = useState<string | null>(null);

  const screenSharer = voice.participants.find((p) => p.hasScreenShare) ?? null;
  const pinned = screenSharer ?? (focusedIdentity ? voice.participants.find((p) => p.identity === focusedIdentity) ?? null : null);

  return (
    <div className="flex-1 flex min-h-0 bg-surface-dim">
      {/* Video area */}
      <div className="flex-1 flex flex-col min-w-0 p-4 gap-3">
        {/* Top bar: back button + status */}
        <div className="flex items-center justify-between flex-shrink-0">
          <button
            type="button"
            onClick={() => voice.setMainViewMode('chat')}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-container border border-border-subtle text-sm text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">chat</span>
            Back to Chat
          </button>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse-soft" />
            <span className="font-medium">{voice.participants.length} in voice</span>
            {voice.micEnabled ? (
              <span className="text-success">- Mic on</span>
            ) : (
              <span className="text-danger">- Muted</span>
            )}
          </div>
        </div>

        {/* Pinned tile (screen share or focused speaker) */}
        {pinned ? (
          <PinnedVideoTile
            participant={pinned}
            isScreenShare={!!screenSharer}
            getCameraTrack={voice.getParticipantCameraTrack}
            getScreenShareTrack={voice.getParticipantScreenShareTrack}
            canMinimize={!screenSharer}
            onMinimize={() => setFocusedIdentity(null)}
          />
        ) : null}

        {/* Participant camera grid */}
        <div className={`grid gap-3 flex-1 min-h-0 ${pinned ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {voice.participants
            .filter((p) => pinned?.identity !== p.identity)
            .map((p) => (
              <CameraTile
                key={p.id}
                participant={p}
                getCameraTrack={voice.getParticipantCameraTrack}
                onClick={() => {
                  if (focusedIdentity === p.identity && !screenSharer) {
                    setFocusedIdentity(null);
                  } else if (!screenSharer) {
                    setFocusedIdentity(p.identity);
                  }
                }}
                isFocused={focusedIdentity === p.identity}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function PinnedVideoTile({
  participant,
  isScreenShare,
  getCameraTrack,
  getScreenShareTrack,
  canMinimize,
  onMinimize,
}: {
  participant: LobbyVoiceParticipant;
  isScreenShare: boolean;
  getCameraTrack: (identity: string) => MediaStreamTrack | null;
  getScreenShareTrack: (identity: string) => MediaStreamTrack | null;
  canMinimize: boolean;
  onMinimize: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = isScreenShare
    ? getScreenShareTrack(participant.identity)
    : getCameraTrack(participant.identity);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    const stream = new MediaStream([track]);
    el.srcObject = stream;
    el.play().catch(() => {});
    return () => { try { el.srcObject = null; } catch {} };
  }, [track]);

  return (
    <div
      className={`relative rounded-xl overflow-hidden border bg-surface-raised flex-shrink-0 ${
        participant.isSpeaking ? 'border-success border-2' : 'border-border-subtle'
      }`}
      style={{ aspectRatio: isScreenShare ? '16 / 9' : '4 / 3', maxHeight: '50vh' }}
    >
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className={isScreenShare ? 'w-full h-full object-contain bg-black' : 'w-full h-full object-cover'}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-20 h-20 rounded-full bg-secondary-container flex items-center justify-center font-bold text-text-primary text-3xl">
            {participant.name.charAt(0).toUpperCase()}
          </div>
        </div>
      )}
      <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/70 backdrop-blur-sm text-[11px] text-text-primary flex items-center gap-1.5">
        {isScreenShare ? <span className="material-symbols-outlined text-[14px] text-success">present_to_all</span> : null}
        <span className="font-medium truncate max-w-[280px]">
          {isScreenShare ? `${participant.name}'s screen` : participant.name}
          
        </span>
      </div>
      {canMinimize ? (
        <button
          type="button"
          onClick={onMinimize}
          className="absolute top-2 right-2 px-2 py-1 rounded bg-black/70 text-[11px] text-text-primary hover:bg-black/90 transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">close_fullscreen</span>
        </button>
      ) : null}
    </div>
  );
}

function CameraTile({
  participant,
  getCameraTrack,
  onClick,
  isFocused,
}: {
  participant: LobbyVoiceParticipant;
  getCameraTrack: (identity: string) => MediaStreamTrack | null;
  onClick: () => void;
  isFocused: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = getCameraTrack(participant.identity);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    const stream = new MediaStream([track]);
    el.srcObject = stream;
    el.play().catch(() => {});
    return () => { try { el.srcObject = null; } catch {} };
  }, [track]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative rounded-xl overflow-hidden border bg-surface-raised cursor-pointer min-h-[120px] transition-all ${
        participant.isSpeaking
          ? 'border-success border-2 speaking-ring'
          : isFocused
            ? 'border-primary border-2'
            : 'border-border-subtle hover:border-border-strong'
      }`}
    >
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className="w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={`w-14 h-14 rounded-full bg-secondary-container flex items-center justify-center font-bold text-text-primary text-xl ${
            participant.isSpeaking ? 'border-2 border-success' : 'border-2 border-transparent'
          }`}>
            {participant.name.charAt(0).toUpperCase()}
          </div>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 flex items-center justify-between text-[11px] text-text-primary pointer-events-none">
        <span className="truncate max-w-[100px]">
          {participant.name}
        </span>
        {!participant.micEnabled ? (
          <span className="material-symbols-outlined text-[12px] text-danger">mic_off</span>
        ) : participant.isSpeaking ? (
          <span className="material-symbols-outlined text-[12px] text-success">mic</span>
        ) : null}
      </div>
    </button>
  );
}


