'use client';

import { cn } from '@lobbyforge/ui';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLobbyVoice, type LobbyVoiceParticipant } from './LobbyVoiceProvider';

export function LobbyVoiceView({ channelName }: { channelId: string; channelName: string }) {
  const voice = useLobbyVoice();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [focusedIdentity, setFocusedIdentity] = useState<string | null>(null);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [participantSort, setParticipantSort] = useState<'default' | 'camera' | 'name'>('default');
  const [selectedScreenIdentity, setSelectedScreenIdentity] = useState<string | null>(null);

  const sortedParticipants = useMemo(
    () => sortParticipants(voice.participants, participantSort),
    [participantSort, voice.participants]
  );
  const screenSharers = sortedParticipants.filter((participant) => participant.hasScreenShare);
  const screenSharer = screenSharers.find((participant) => participant.identity === selectedScreenIdentity)
    ?? screenSharers[0]
    ?? null;
  const screenShareJoined = screenSharer ? voice.isScreenShareJoined(screenSharer.identity) : false;
  const screenSharerHasCamera = Boolean(screenSharer && voice.getParticipantCameraTrack(screenSharer.identity));
  const focused = focusedIdentity
    ? voice.participants.find((participant) => participant.identity === focusedIdentity) ?? null
    : null;
  const pinned = screenShareJoined ? screenSharer : focused;
  const stripParticipants = sortedParticipants.filter((participant) =>
    !(screenSharer && screenShareJoined && screenSharerHasCamera && participant.identity === screenSharer.identity)
  );
  const hasCamera = voice.participants.some((participant) =>
    Boolean(voice.getParticipantCameraTrack(participant.identity))
  );
  const gridClass = useMemo(() => participantGridClass(sortedParticipants.length), [sortedParticipants.length]);

  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('lf-voice-participant-sort');
      if (saved === 'camera' || saved === 'name') setParticipantSort(saved);
    } catch { /* local preference unavailable */ }
  }, []);

  useEffect(() => {
    if (selectedScreenIdentity && !screenSharers.some((participant) => participant.identity === selectedScreenIdentity)) {
      setSelectedScreenIdentity(screenSharers[0]?.identity ?? null);
    }
  }, [screenSharers, selectedScreenIdentity]);

  function changeParticipantSort(next: 'default' | 'camera' | 'name') {
    setParticipantSort(next);
    try { window.localStorage.setItem('lf-voice-participant-sort', next); } catch { /* local preference unavailable */ }
  }

  useEffect(() => {
    const sync = () => setBrowserFullscreen(Boolean(document.fullscreenElement));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) voice.setMainViewMode('chat');
    };
    document.addEventListener('fullscreenchange', sync);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [voice]);

  async function toggleBrowserFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      // The focus view remains usable when the browser denies fullscreen.
    }
  }

  if (!portalReady) return null;

  return createPortal(
    <div
      ref={rootRef}
      data-testid="voice-focus-view"
      className="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-[#111318] text-white"
    >
      <header className="flex h-12 flex-none items-center justify-between gap-3 border-b border-white/10 bg-[#17191f] px-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton label="Back to chat" icon="arrow_back" onClick={() => voice.setMainViewMode('chat')} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[17px] text-white/55" aria-hidden>volume_up</span>
              <h1 className="truncate text-sm font-semibold text-white">{channelName}</h1>
            </div>
          </div>
          <span className="hidden h-5 items-center gap-1.5 rounded bg-white/7 px-2 text-[11px] text-white/60 sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
            {voice.participants.length} connected
          </span>
        </div>

        <div className="flex flex-none items-center gap-0.5">
          <label className="mr-1 hidden items-center gap-1.5 text-[11px] text-white/45 sm:flex">
            <span className="material-symbols-outlined text-[16px]" aria-hidden>sort</span>
            <select
              value={participantSort}
              onChange={(event) => changeParticipantSort(event.target.value as 'default' | 'camera' | 'name')}
              className="h-8 rounded-md border border-white/10 bg-white/5 px-2 text-xs text-white/75 outline-none"
              aria-label="Participant order"
            >
              <option value="default">Default order</option>
              <option value="camera">Camera first</option>
              <option value="name">Name</option>
            </select>
          </label>
          {screenSharer ? (
            <div className="mr-1 hidden items-center gap-2 md:flex">
              {screenSharers.length > 1 ? (
                <select
                  value={screenSharer.identity}
                  onChange={(event) => setSelectedScreenIdentity(event.target.value)}
                  className="h-8 max-w-40 rounded-md border border-white/10 bg-white/5 px-2 text-xs text-white/75 outline-none"
                  aria-label="Active stream"
                >
                  {screenSharers.map((participant) => <option key={participant.identity} value={participant.identity}>{participant.name}</option>)}
                </select>
              ) : <span className="max-w-44 truncate text-xs text-white/55">{screenSharer.name} is sharing</span>}
              <button
                type="button"
                onClick={() => void (screenShareJoined
                  ? voice.leaveScreenShare(screenSharer.identity)
                  : voice.joinScreenShare(screenSharer.identity))}
                className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/15"
              >
                {screenShareJoined ? 'Leave stream' : 'Join stream'}
              </button>
            </div>
          ) : null}
          <IconButton
            label={browserFullscreen ? 'Exit browser fullscreen' : 'Enter browser fullscreen'}
            icon={browserFullscreen ? 'fullscreen_exit' : 'fullscreen'}
            onClick={() => void toggleBrowserFullscreen()}
          />
          <IconButton label="Close voice view" icon="close" onClick={() => voice.setMainViewMode('chat')} />
        </div>
      </header>

      {voice.error ? (
        <div role="alert" className="flex flex-none items-center gap-2 border-b border-red-400/25 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          <span className="material-symbols-outlined text-[18px]" aria-hidden>error</span>
          <span className="min-w-0 flex-1 truncate sm:whitespace-normal">{voice.error}</span>
        </div>
      ) : null}

      <main className="relative flex min-h-0 flex-1 overflow-hidden p-2 pb-20 sm:p-3 sm:pb-20">
        {screenSharers.some((participant) => !voice.isScreenShareJoined(participant.identity)) ? (
          <div className="absolute inset-x-3 top-3 z-10 flex justify-center gap-2 overflow-x-auto" aria-label="Available streams">
            {screenSharers.filter((participant) => !voice.isScreenShareJoined(participant.identity)).map((participant) => (
              <StreamPreviewCard
                key={participant.identity}
                participant={participant}
                track={voice.getParticipantScreenShareTrack(participant.identity)}
                onJoin={() => {
                  setSelectedScreenIdentity(participant.identity);
                  void voice.joinScreenShare(participant.identity);
                }}
              />
            ))}
          </div>
        ) : null}
        {pinned ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:flex-row">
            <div className={cn(
              'grid min-h-0 min-w-0 flex-1 gap-2',
              screenSharer && screenShareJoined && screenSharerHasCamera
                ? 'grid-cols-1 md:grid-cols-2'
                : 'grid-cols-1'
            )}>
              <PinnedVideoTile
                participant={pinned}
                isScreenShare={Boolean(screenSharer && screenShareJoined)}
                getCameraTrack={voice.getParticipantCameraTrack}
                getScreenShareTrack={voice.getParticipantScreenShareTrack}
                canMinimize={!screenSharer || !screenShareJoined}
                onMinimize={() => setFocusedIdentity(null)}
              />
              {screenSharer && screenShareJoined && screenSharerHasCamera ? (
                <PinnedVideoTile
                  participant={screenSharer}
                  isScreenShare={false}
                  getCameraTrack={voice.getParticipantCameraTrack}
                  getScreenShareTrack={voice.getParticipantScreenShareTrack}
                  canMinimize={false}
                  onMinimize={() => undefined}
                />
              ) : null}
            </div>
            {stripParticipants.length > 0 ? (
              <div
                className="flex h-24 flex-none gap-2 overflow-x-auto lg:h-auto lg:w-52 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto"
                aria-label="Call participants"
              >
                {stripParticipants.map((participant) => (
                  <CameraTile
                    key={participant.id}
                    participant={participant}
                    compact
                    getCameraTrack={voice.getParticipantCameraTrack}
                    onClick={() => {
                      if (!screenShareJoined) setFocusedIdentity(participant.identity);
                    }}
                    isFocused={pinned.identity === participant.identity}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : sortedParticipants.length > 0 && !hasCamera ? (
          <VoiceOnlyStage participants={sortedParticipants} />
        ) : sortedParticipants.length > 0 ? (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto">
            <div
              className={cn(
                'grid w-full content-center gap-2 sm:gap-3',
                gridClass
              )}
              aria-label="Call participants"
            >
              {sortedParticipants.map((participant) => (
                <CameraTile
                  key={participant.id}
                  participant={participant}
                  getCameraTrack={voice.getParticipantCameraTrack}
                  onClick={() => setFocusedIdentity(participant.identity)}
                  isFocused={false}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center text-center">
            <div>
              <span className="material-symbols-outlined text-4xl text-white/35" aria-hidden>graphic_eq</span>
              <p className="mt-2 text-sm font-medium">Connecting to voice</p>
              <p className="mt-1 text-xs text-white/45">Participants will appear here.</p>
            </div>
          </div>
        )}
      </main>

      <VoiceControls channelName={channelName} />
    </div>,
    document.body
  );
}

function participantGridClass(count: number): string {
  if (count <= 1) return 'max-w-2xl grid-cols-1';
  if (count === 2) return 'max-w-5xl grid-cols-1 sm:grid-cols-2';
  if (count <= 4) return 'max-w-6xl grid-cols-2';
  if (count <= 6) return 'max-w-7xl grid-cols-2 lg:grid-cols-3';
  return 'max-w-7xl grid-cols-2 md:grid-cols-3 xl:grid-cols-4';
}

function sortParticipants(
  participants: LobbyVoiceParticipant[],
  mode: 'default' | 'camera' | 'name'
): LobbyVoiceParticipant[] {
  const rows = [...participants];
  if (mode === 'name') return rows.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === 'camera') {
    return rows.sort((a, b) =>
      Number(b.cameraEnabled) - Number(a.cameraEnabled)
      || Number(b.hasScreenShare) - Number(a.hasScreenShare)
      || a.name.localeCompare(b.name)
    );
  }
  return rows;
}

function VoiceOnlyStage({ participants }: { participants: LobbyVoiceParticipant[] }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto">
      <div
        className={cn(
          'grid max-w-4xl gap-2 sm:gap-3',
          voiceOnlyGridClass(participants.length)
        )}
        aria-label="Call participants"
      >
        {participants.map((participant) => (
          <div
            key={participant.id}
            className={cn(
              'flex h-28 w-36 flex-col items-center justify-center gap-2 rounded-md border bg-[#1a1d23] px-3 sm:h-32 sm:w-44',
              participant.isSpeaking ? 'border-emerald-400/80' : 'border-white/10'
            )}
          >
            <div
              className={cn(
                'grid size-12 place-items-center rounded-full bg-[#343943] text-base font-semibold text-white/90 ring-2 ring-white/8 sm:size-14 sm:text-lg',
                participant.isSpeaking && 'ring-emerald-400'
              )}
              aria-hidden
            >
              {participant.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex max-w-full items-center gap-1.5 text-xs text-white/80">
              <span className="truncate font-medium">{participant.name}</span>
              {!participant.micEnabled ? (
                <span className="material-symbols-outlined flex-none text-[14px] text-red-300" aria-label="Muted">mic_off</span>
              ) : participant.isSpeaking ? (
                <span className="material-symbols-outlined flex-none text-[14px] text-emerald-300" aria-label="Speaking">graphic_eq</span>
              ) : null}
              {participant.cameraEnabled ? <span className="material-symbols-outlined flex-none text-[14px] text-sky-300" aria-label="Camera on">videocam</span> : null}
              {participant.hasScreenShare ? <span className="material-symbols-outlined flex-none text-[14px] text-emerald-300" aria-label="Sharing screen">present_to_all</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function voiceOnlyGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-2';
  if (count === 3) return 'grid-cols-2 md:grid-cols-3';
  return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
}

function VoiceControls({ channelName }: { channelName: string }) {
  const voice = useLobbyVoice();
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const qualityOptions = [
    { value: 'low', height: 480, label: '480p' },
    { value: 'standard', height: 720, label: '720p' },
    { value: 'high', height: 1080, label: '1080p' },
    { value: 'q1440', height: 1440, label: '1440p' },
    { value: 'q2160', height: 2160, label: '2160p' },
  ].filter((option) => option.height <= voice.screenSharePolicy.maxHeight);
  const fpsOptions = ['15', '30', '60'].filter((fps) => Number(fps) <= voice.screenSharePolicy.maxFps);

  useEffect(() => {
    if (voice.screenShareEnabled) setShareMenuOpen(false);
  }, [voice.screenShareEnabled]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-2 pb-[max(10px,env(safe-area-inset-bottom))]">
      <div
        data-testid="voice-control-dock"
        className="pointer-events-auto flex h-16 max-w-full items-center gap-1.5 rounded-lg border border-white/10 bg-[#17191f] px-2 shadow-2xl sm:gap-2 sm:px-3"
      >
        <div className="hidden min-w-0 items-center gap-2 border-r border-white/10 pr-3 md:flex">
          <span className="grid size-8 flex-none place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
            <span className="material-symbols-outlined text-[17px]" aria-hidden>graphic_eq</span>
          </span>
          <div className="min-w-0 leading-tight">
            <p className="max-w-28 truncate text-xs font-semibold text-white/90">{channelName}</p>
            <p className="text-[10px] text-emerald-300/80">Voice connected</p>
          </div>
        </div>

        <CallControlButton
          label={voice.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          icon={voice.micEnabled ? 'mic' : 'mic_off'}
          pressed={!voice.micEnabled}
          danger={!voice.micEnabled}
          onClick={() => void voice.toggleMic()}
        />
        <CallControlButton
          label={voice.deafenEnabled ? 'Undeafen' : 'Deafen'}
          icon={voice.deafenEnabled ? 'headphones_off' : 'headphones'}
          pressed={voice.deafenEnabled}
          danger={voice.deafenEnabled}
          onClick={voice.toggleDeafen}
        />
        <span className="h-7 w-px bg-white/10" aria-hidden />
        <CallControlButton
          label={voice.cameraEnabled ? 'Stop camera' : 'Start camera'}
          icon={voice.cameraEnabled ? 'videocam' : 'videocam_off'}
          pressed={voice.cameraEnabled}
          onClick={() => void voice.toggleCamera()}
        />

        <div className={cn(
          'relative flex h-11 flex-none items-stretch overflow-visible rounded-full transition-colors',
          voice.screenShareEnabled ? 'bg-emerald-400 text-[#0d1a14]' : 'bg-white/10 text-white/80 hover:bg-white/15 hover:text-white'
        )}>
          <button
            type="button"
            onClick={() => void voice.toggleScreenShare()}
            title={voice.screenShareEnabled ? 'Stop sharing' : 'Share screen'}
            aria-label={voice.screenShareEnabled ? 'Stop sharing' : 'Share screen'}
            aria-pressed={voice.screenShareEnabled}
            className="grid w-10 place-items-center rounded-l-full"
          >
            <span className="material-symbols-outlined text-[21px]" aria-hidden>{voice.screenShareEnabled ? 'stop_screen_share' : 'screen_share'}</span>
          </button>
          {!voice.screenShareEnabled ? (
            <button type="button" onClick={() => setShareMenuOpen((open) => !open)} aria-label="Stream quality" aria-expanded={shareMenuOpen} className="grid w-6 place-items-center rounded-r-full border-l border-white/10 text-white/55 hover:text-white">
              <span className="material-symbols-outlined text-[16px]" aria-hidden>expand_less</span>
            </button>
          ) : null}
          {shareMenuOpen && !voice.screenShareEnabled ? (
            <div className="absolute bottom-14 right-0 z-30 w-60 rounded-md border border-white/10 bg-[#252830] p-2.5 text-white shadow-2xl">
              <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase text-white/45">Stream quality</p>
              <div className="grid grid-cols-2 gap-1">
                {qualityOptions.map((option) => (
                  <button key={option.value} type="button" onClick={() => void voice.setScreenSharePreference(option.value as 'low' | 'standard' | 'high' | 'q1440' | 'q2160', voice.screenSharePreference.fps)} className={cn('rounded-md px-2 py-1.5 text-xs text-white/65 hover:bg-white/8', voice.screenSharePreference.quality === option.value && 'bg-primary/20 text-primary')}>{option.label}</button>
                ))}
              </div>
              <p className="mt-2 px-1 pb-1.5 text-[10px] font-semibold uppercase text-white/45">Frame rate</p>
              <div className="grid grid-cols-3 gap-1">
                {fpsOptions.map((fps) => (
                  <button key={fps} type="button" onClick={() => void voice.setScreenSharePreference(voice.screenSharePreference.quality, fps as '15' | '30' | '60')} className={cn('rounded-md px-2 py-1.5 text-xs text-white/65 hover:bg-white/8', voice.screenSharePreference.fps === fps && 'bg-primary/20 text-primary')}>{fps}</button>
                ))}
              </div>
              <p className="mt-2 px-1 text-[10px] text-white/35">Server maximum: {voice.screenSharePolicy.maxHeight}p / {voice.screenSharePolicy.maxFps} FPS</p>
            </div>
          ) : null}
        </div>

        <Link
          href="/settings/voice-video"
          title="Voice & Video settings"
          aria-label="Voice & Video settings"
          className="grid size-11 flex-none place-items-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
        >
          <span className="material-symbols-outlined text-[21px]" aria-hidden>settings</span>
        </Link>
        <span className="h-7 w-px bg-white/10" aria-hidden />
        <button
          type="button"
          onClick={() => void voice.disconnect()}
          title="Disconnect"
          aria-label="Disconnect"
          className="grid size-11 flex-none place-items-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-400"
        >
          <span className="material-symbols-outlined text-[21px]" aria-hidden>call_end</span>
        </button>
      </div>
    </div>
  );
}

function CallControlButton({
  label,
  icon,
  pressed,
  danger = false,
  onClick,
}: {
  label: string;
  icon: string;
  pressed: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'grid size-11 flex-none place-items-center rounded-full transition-colors',
        danger
          ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
          : pressed
            ? 'bg-white text-[#111318] hover:bg-white/90'
            : 'bg-white/10 text-white/80 hover:bg-white/15 hover:text-white'
      )}
    >
      <span className="material-symbols-outlined text-[21px]" aria-hidden>{icon}</span>
    </button>
  );
}

function IconButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-9 flex-none place-items-center rounded-md text-white/60 transition-colors hover:bg-white/8 hover:text-white"
    >
      <span className="material-symbols-outlined text-[20px]" aria-hidden>{icon}</span>
    </button>
  );
}

function useVideoTrack(videoRef: RefObject<HTMLVideoElement | null>, track: MediaStreamTrack | null) {
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !track) return;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [track, videoRef]);
}

function StreamPreviewCard({
  participant,
  track,
  onJoin,
}: {
  participant: LobbyVoiceParticipant;
  track: MediaStreamTrack | null;
  onJoin: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useVideoTrack(videoRef, track);
  return (
    <div className="flex h-16 w-64 flex-none items-center gap-2 rounded-md border border-white/10 bg-[#20232a] p-2 shadow-lg">
      <div className="grid h-12 w-20 flex-none place-items-center overflow-hidden rounded bg-black/60">
        {track ? <video ref={videoRef} autoPlay playsInline muted className="size-full object-contain" /> : <span className="material-symbols-outlined text-[20px] text-emerald-300" aria-hidden>present_to_all</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white">{participant.isLocal ? 'Your stream' : participant.name}</p>
        <button type="button" onClick={onJoin} className="mt-1 text-xs font-semibold text-primary hover:underline">Join stream</button>
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
  useVideoTrack(videoRef, track);

  return (
    <section className={cn(
      'relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border bg-black',
      participant.isSpeaking ? 'border-emerald-400/80' : 'border-white/10'
    )}>
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className={cn('size-full', isScreenShare ? 'object-contain' : 'object-cover')}
        />
      ) : (
        <ParticipantPlaceholder participant={participant} large />
      )}
      <div className="absolute left-2 top-2 flex max-w-[70%] items-center gap-1.5 rounded bg-black/75 px-2 py-1 text-xs text-white/85">
        {isScreenShare ? <span className="material-symbols-outlined text-[15px] text-emerald-300" aria-hidden>present_to_all</span> : null}
        <span className="truncate font-medium">{isScreenShare ? `${participant.name}'s screen` : participant.name}</span>
      </div>
      {canMinimize ? (
        <button
          type="button"
          onClick={onMinimize}
          title="Return to grid"
          aria-label="Return to grid"
          className="absolute right-2 top-2 grid size-8 place-items-center rounded-md bg-black/75 text-white/70 hover:text-white"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden>grid_view</span>
        </button>
      ) : null}
    </section>
  );
}

function CameraTile({
  participant,
  getCameraTrack,
  onClick,
  isFocused,
  compact = false,
}: {
  participant: LobbyVoiceParticipant;
  getCameraTrack: (identity: string) => MediaStreamTrack | null;
  onClick: () => void;
  isFocused: boolean;
  compact?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = getCameraTrack(participant.identity);
  useVideoTrack(videoRef, track);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Focus ${participant.name}`}
      className={cn(
        'group relative min-w-0 overflow-hidden rounded-md border bg-[#1a1d23] text-left',
        compact ? 'h-full w-36 flex-none lg:h-28 lg:w-full' : 'aspect-video w-full min-h-28 max-h-[42vh]',
        participant.isSpeaking
          ? 'border-emerald-400/80'
          : isFocused
            ? 'border-white/45'
            : 'border-white/10 hover:border-white/25'
      )}
    >
      {track ? (
        <video ref={videoRef} autoPlay playsInline muted={participant.isLocal} className="size-full object-cover" />
      ) : (
        <ParticipantPlaceholder participant={participant} compact={compact} />
      )}
      <div className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-between bg-black/70 px-2 text-xs text-white/85">
        <span className="truncate font-medium">{participant.name}</span>
        {!participant.micEnabled ? (
          <span className="material-symbols-outlined text-[14px] text-red-300" aria-label="Muted">mic_off</span>
        ) : participant.isSpeaking ? (
          <span className="material-symbols-outlined text-[14px] text-emerald-300" aria-label="Speaking">graphic_eq</span>
        ) : null}
        {participant.hasScreenShare ? <span className="material-symbols-outlined text-[14px] text-emerald-300" aria-label="Sharing screen">present_to_all</span> : null}
      </div>
    </button>
  );
}

function ParticipantPlaceholder({
  participant,
  large = false,
  compact = false,
}: {
  participant: LobbyVoiceParticipant;
  large?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#1a1d23]">
      <div className={cn(
        'grid place-items-center rounded-full bg-[#343943] font-semibold text-white/90 ring-2 ring-white/8',
        large ? 'size-20 text-2xl sm:size-24 sm:text-3xl' : compact ? 'size-11 text-sm' : 'size-14 text-lg sm:size-16 sm:text-xl',
        participant.isSpeaking && 'ring-emerald-400'
      )}>
        {participant.name.charAt(0).toUpperCase()}
      </div>
    </div>
  );
}
