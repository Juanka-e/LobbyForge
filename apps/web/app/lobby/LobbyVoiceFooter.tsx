'use client';

import { useLobbyVoice, ConnectionState } from './LobbyVoiceProvider';
import { LobbyPresenceMenu } from './LobbyPresenceMenu';
import Link from 'next/link';

/**
 * Voice footer - same visual frame as the M19 `VoiceControlFooter`,
 * wired to real LiveKit state via `useLobbyVoice`. The "Voice Ready"
 * vs "Voice Connected" label and the mic / call-end buttons are
 * functional rather than decorative when the user is connected.
 *
 * When not connected the footer still renders (so the layout doesn't
 * shift on connect / disconnect) but the call-end button is disabled.
 */

export interface LobbyVoiceFooterProps {
  serverName: string;
  hasUser: boolean;
  /** The local user's display name (avatar initial). */
  displayName?: string;
}

export function LobbyVoiceFooter({ serverName, hasUser, displayName }: LobbyVoiceFooterProps) {
  const voice = useLobbyVoice();
  const connected = voice.connectionState === ConnectionState.Connected && !!voice.activeChannelId;
  const connecting = voice.connecting || voice.connectionState === ConnectionState.Connecting || voice.connectionState === ConnectionState.Reconnecting;
  const stateLabel = connecting
    ? voice.connectionState === ConnectionState.Reconnecting
      ? 'Reconnecting...'
      : 'Connecting...'
    : connected
      ? 'Voice Connected'
      : 'Voice Ready';

  return (
    <div className="mt-auto border-t border-border-subtle bg-surface-raised flex flex-col">
      <div className="bg-surface-container-lowest p-3 border-b border-border-subtle">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <div
                className={
                  connected
                    ? 'w-2 h-2 rounded-full bg-success animate-pulse-soft'
                    : voice.connecting
                      ? 'w-2 h-2 rounded-full bg-tertiary'
                      : 'w-2 h-2 rounded-full bg-text-muted'
                }
              />
              <span
                className={
                  connected
                    ? 'text-[11px] text-success font-bold uppercase tracking-tight'
                    : voice.connecting
                      ? 'text-[11px] text-tertiary font-bold uppercase tracking-tight'
                      : 'text-[11px] text-text-muted font-bold uppercase tracking-tight'
                }
              >
                {stateLabel}
              </span>
            </div>
            <button className="text-[13px] text-text-secondary hover:text-text-primary transition-colors truncate text-left">
              {serverName}
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!connected}
              onClick={() => void voice.toggleScreenShare()}
              title={voice.screenShareEnabled ? 'Stop screen share' : 'Share your screen'}
              aria-label={voice.screenShareEnabled ? 'Stop screen share' : 'Share your screen'}
              className={
                connected
                  ? voice.screenShareEnabled
                    ? 'p-1.5 rounded bg-tertiary/20 text-tertiary hover:bg-tertiary/30 transition-colors'
                    : 'p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors'
                  : 'p-1.5 rounded text-text-secondary opacity-30 cursor-not-allowed'
              }
            >
              <span className="material-symbols-outlined text-[18px]">screen_share</span>
            </button>
            <button
              type="button"
              disabled={!connected}
              onClick={() => void voice.toggleCamera()}
              title={voice.cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
              aria-label={voice.cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
              className={
                connected
                  ? voice.cameraEnabled
                    ? 'p-1.5 rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors'
                    : 'p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors'
                  : 'p-1.5 rounded text-text-secondary opacity-30 cursor-not-allowed'
              }
            >
              <span className="material-symbols-outlined text-[18px]">videocam</span>
            </button>
            <button
              type="button"
              disabled={!connected}
              onClick={() => void voice.disconnect()}
              title="Disconnect"
              aria-label="Disconnect from voice"
              className="p-1.5 rounded hover:bg-surface-container text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[18px]">call_end</span>
            </button>
          </div>
        </div>
        {voice.error ? (
          <p className="text-[11px] text-danger mt-1 line-clamp-3" role="alert" title={voice.error}>
            {voice.error}
          </p>
        ) : null}
        {connected && voice.audioBlocked && voice.startAudio ? (
          <button
            type="button"
            onClick={() => void voice.startAudio?.()}
            className="mt-2 w-full rounded bg-primary/20 px-2 py-1 text-[12px] font-medium text-primary hover:bg-primary/30 transition-colors"
          >
            Your browser blocked audio — click to enable
          </button>
        ) : null}
      </div>
      <div className="p-3 bg-surface-raised">
        <div className="flex items-center justify-between gap-2">
          <LobbyPresenceMenu
            displayName={displayName ?? ''}
            hasUser={hasUser}
            status={voice.presenceStatus}
            onChange={voice.setPresenceStatus}
            voiceLabel={
              connected
                ? voice.serverMuted
                  ? 'Server muted'
                  : voice.micEnabled
                    ? 'Unmuted'
                    : 'Muted'
                : null
            }
          />
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!connected}
              onClick={() => void voice.toggleMic()}
              title={voice.serverMuted ? 'Muted by a moderator' : voice.micEnabled ? 'Mute' : 'Unmute'}
              aria-label={voice.serverMuted ? 'Muted by a moderator' : voice.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
              className={
                connected
                  ? voice.micEnabled
                    ? 'p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors'
                    : 'p-1.5 rounded bg-danger/20 text-danger hover:bg-danger/30 transition-colors'
                  : 'p-1.5 rounded text-text-secondary opacity-30 cursor-not-allowed'
              }
            >
              <span className="material-symbols-outlined text-[18px]">
                {voice.micEnabled ? 'mic' : 'mic_off'}
              </span>
            </button>
            <button
              type="button"
              disabled={!connected}
              onClick={() => voice.toggleDeafen()}
              title={voice.deafenEnabled ? 'Undeafen' : 'Deafen'}
              aria-label={voice.deafenEnabled ? 'Undeafen' : 'Deafen audio'}
              className={
                connected
                  ? voice.deafenEnabled
                    ? 'p-1.5 rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors'
                    : 'p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors'
                  : 'p-1.5 rounded text-text-secondary opacity-30 cursor-not-allowed'
              }
            >
              <span className="material-symbols-outlined text-[18px]">headphones</span>
            </button>
            <Link
              href="/settings/voice-video"
              title="Voice & video settings"
              aria-label="Voice and video settings"
              className="p-1.5 rounded hover:bg-surface-container text-text-secondary hover:text-text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">settings</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

