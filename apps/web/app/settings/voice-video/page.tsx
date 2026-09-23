'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter, { type SettingsStatus } from '@/app/settings/SettingsStickyFooter';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import {
  DEFAULT_VOICE_VIDEO_PREFERENCES,
  mergeVoiceVideoPreferences,
  type ScreenFps,
  type ScreenQuality,
  type VoiceVideoPreferences,
} from '@/lib/voice-video-preferences';
import { setVoiceTestState } from '@/lib/voice-test-events';

type SettingsResponse = {
  settings: {
    audio: Partial<VoiceVideoPreferences> | Record<string, unknown>;
    updatedAt: string;
  };
};

type DeviceOption = { deviceId: string; label: string };
type PermissionStateName = 'unknown' | 'granted' | 'prompt' | 'denied';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status} ${JSON.stringify(detail)}`);
  }
  return (await res.json()) as T;
}

function deviceLabel(device: MediaDeviceInfo, fallback: string): string {
  return device.label || fallback;
}

/**
 * Device names come from the browser and are shown as they are; only the
 * stand-ins for a device the browser has not named yet are ours to word.
 */
function uniqueDevices(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  numbered: (n: number) => string,
  defaultLabel: string
): DeviceOption[] {
  const seen = new Set<string>();
  const rows = devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId || 'default',
      label: deviceLabel(device, numbered(index + 1)),
    }))
    .filter((device) => {
      const key = `${device.deviceId}:${device.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return rows.length ? rows : [{ deviceId: 'default', label: defaultLabel }];
}

/**
 * The saved label is what the browser called the device — except the
 * English placeholder every account starts with, which is ours to translate.
 */
function savedDeviceLabel(label: string, englishDefault: string, translatedDefault: string): string {
  return label === englishDefault ? translatedDefault : label;
}

const SCREEN_QUALITIES: ScreenQuality[] = ['auto', 'low', 'standard', 'high', 'q1440', 'q2160'];

function screenQualityLabel(quality: ScreenQuality, t: Translator): string {
  switch (quality) {
    case 'low':
      return t('settings.voiceVideo.screen.low');
    case 'standard':
      return t('settings.voiceVideo.screen.standard');
    case 'high':
      return t('settings.voiceVideo.screen.high');
    case 'q1440':
      return '1440p';
    case 'q2160':
      return '2160p (4K)';
    default:
      return t('settings.voiceVideo.screen.auto');
  }
}

const PERMISSION_LABEL_KEYS: Record<PermissionStateName, string> = {
  granted: 'settings.voiceVideo.status.permission.granted',
  denied: 'settings.voiceVideo.status.permission.denied',
  prompt: 'settings.voiceVideo.status.permission.prompt',
  unknown: 'settings.voiceVideo.status.permission.unknown',
};

const MEDIA_KIND_KEYS = {
  microphone: 'settings.voiceVideo.msg.kind.microphone',
  camera: 'settings.voiceVideo.msg.kind.camera',
} as const;

function constraintsForAudio(prefs: VoiceVideoPreferences): MediaTrackConstraints {
  return {
    deviceId: prefs.inputDeviceId && prefs.inputDeviceId !== 'default'
      ? { exact: prefs.inputDeviceId }
      : undefined,
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.automaticGainControl,
  };
}

function constraintsForCamera(prefs: VoiceVideoPreferences): MediaTrackConstraints {
  return {
    deviceId: prefs.cameraDeviceId && prefs.cameraDeviceId !== 'default'
      ? { exact: prefs.cameraDeviceId }
      : undefined,
    frameRate: Number(prefs.screenFps),
  };
}

export default function VoiceVideoSettingsPage() {
  const t = useT();
  const [prefs, setPrefs] = useState<VoiceVideoPreferences>(DEFAULT_VOICE_VIDEO_PREFERENCES);
  const [savedSnapshot, setSavedSnapshot] = useState<VoiceVideoPreferences>(DEFAULT_VOICE_VIDEO_PREFERENCES);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SettingsStatus>({ key: 'settings.footer.loading' });
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionStateName>('unknown');
  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null);
  const analyserStopRef = useRef<(() => void) | null>(null);

  const dirty = useMemo(() => JSON.stringify(prefs) !== JSON.stringify(savedSnapshot), [prefs, savedSnapshot]);
  const disabled = busy || !dirty;

  async function refreshDevices(requestPermission = false) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus({ key: 'settings.voiceVideo.msg.noDevices' });
      return;
    }
    const denied: (keyof typeof MEDIA_KIND_KEYS)[] = [];
    if (requestPermission) {
      // beta-review: ask for each kind separately — a combined
      // {audio, video} request fails outright on a PC without a webcam,
      // so microphone labels never appeared.
      for (const [kind, constraints] of [
        ['microphone', { audio: true }],
        ['camera', { video: true }],
      ] as const) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          denied.push(kind);
        }
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(
      uniqueDevices(
        devices,
        'audioinput',
        (n) => t('settings.voiceVideo.devices.microphoneN', { n }),
        t('settings.voiceVideo.devices.defaultMicrophone')
      )
    );
    setOutputs(
      uniqueDevices(
        devices,
        'audiooutput',
        (n) => t('settings.voiceVideo.devices.speakersN', { n }),
        t('settings.voiceVideo.devices.defaultSpeakers')
      )
    );
    setCameras(
      uniqueDevices(
        devices,
        'videoinput',
        (n) => t('settings.voiceVideo.devices.cameraN', { n }),
        t('settings.voiceVideo.devices.defaultCamera')
      )
    );
    setStatus(
      !requestPermission
        ? { key: 'settings.footer.ready' }
        : denied.length
          ? {
              key: 'settings.voiceVideo.msg.refreshedPartial',
              params: { kinds: denied.map((kind) => t(MEDIA_KIND_KEYS[kind])).join(', ') },
            }
          : { key: 'settings.voiceVideo.msg.refreshed' }
    );
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let data: SettingsResponse;
        try {
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        } catch (err) {
          if (!(err as Error).message.startsWith('HTTP 401')) throw err;
          await jsonFetch('/api/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        }
        if (cancelled) return;
        const merged = mergeVoiceVideoPreferences(data.settings.audio);
        setPrefs(merged);
        setSavedSnapshot(merged);
        setUpdatedAt(data.settings.updatedAt);
        await refreshDevices(false).catch(() => setStatus({ key: 'settings.voiceVideo.msg.needPermission' }));
      } catch (err) {
        if (!cancelled) setStatus({ text: (err as Error).message });
      }
    }
    void load();
    return () => {
      cancelled = true;
      stopCamera();
      stopMicTest();
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions) return;
    let cancelled = false;
    void navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (cancelled) return;
        setPermission(result.state);
        result.onchange = () => !cancelled && setPermission(result.state);
      })
      .catch(() => !cancelled && setPermission('unknown'));
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(patch: Partial<VoiceVideoPreferences>) {
    setPrefs((current) => ({ ...current, ...patch }));
  }

  function patchDevice(kind: 'input' | 'output' | 'camera', deviceId: string) {
    const list = kind === 'input' ? inputs : kind === 'output' ? outputs : cameras;
    const selected = list.find((device) => device.deviceId === deviceId);
    if (kind === 'input') {
      patch({ inputDeviceId: deviceId, inputDeviceLabel: selected?.label ?? t('settings.voiceVideo.devices.selectedMicrophone') });
    } else if (kind === 'output') {
      patch({ outputDeviceId: deviceId, outputDeviceLabel: selected?.label ?? t('settings.voiceVideo.devices.selectedSpeakers') });
    } else {
      patch({ cameraDeviceId: deviceId, cameraLabel: selected?.label ?? t('settings.voiceVideo.devices.selectedCamera') });
      if (cameraOn) void startCamera({ ...prefs, cameraDeviceId: deviceId, cameraLabel: selected?.label ?? prefs.cameraLabel });
    }
  }

  async function save() {
    setBusy(true);
    setStatus({ key: 'settings.footer.saving' });
    try {
      const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: prefs }),
      });
      const merged = mergeVoiceVideoPreferences(data.settings.audio);
      setPrefs(merged);
      setSavedSnapshot(merged);
      setUpdatedAt(data.settings.updatedAt);
      setStatus({ key: 'settings.footer.saved' });
    } catch (err) {
      setStatus({ text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPrefs(DEFAULT_VOICE_VIDEO_PREFERENCES);
  }

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function startCamera(nextPrefs = prefs) {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraintsForCamera(nextPrefs), audio: false });
    cameraStreamRef.current = stream;
    if (previewRef.current) {
      previewRef.current.srcObject = stream;
      await previewRef.current.play().catch(() => {});
    }
    setCameraOn(true);
    setStatus({ key: 'settings.voiceVideo.msg.cameraRunning' });
  }

  async function toggleCameraPreview() {
    try {
      if (cameraOn) {
        stopCamera();
        setStatus({ key: 'settings.voiceVideo.msg.cameraStopped' });
      } else {
        await startCamera();
        await refreshDevices(false);
      }
    } catch (err) {
      setStatus({ key: 'settings.voiceVideo.msg.cameraFailed', params: { error: (err as Error).message } });
    }
  }

  function stopMicTest() {
    setVoiceTestState('microphone', false);
    analyserStopRef.current?.();
    analyserStopRef.current = null;
    if (monitorAudioRef.current) {
      monitorAudioRef.current.pause();
      monitorAudioRef.current.srcObject = null;
      monitorAudioRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setMicTesting(false);
    setMicLevel(0);
  }

  async function toggleMicTest() {
    try {
      if (micTesting) {
        stopMicTest();
        setStatus({ key: 'settings.voiceVideo.msg.micStopped' });
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsForAudio(prefs), video: false });
      setVoiceTestState('microphone', true);
      micStreamRef.current = stream;
      const monitor = new Audio();
      monitor.srcObject = stream;
      monitor.volume = Math.max(0.05, Math.min(0.5, prefs.outputVolume / 200));
      const maybeSink = monitor as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (typeof maybeSink.setSinkId === 'function' && prefs.outputDeviceId !== 'default') {
        await maybeSink.setSinkId(prefs.outputDeviceId);
      }
      await monitor.play().catch(() => {});
      monitorAudioRef.current = monitor;
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      let frame = 0;
      const tick = () => {
        analyser.getByteFrequencyData(samples);
        const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        setMicLevel(Math.min(100, Math.round((average / 128) * 100)));
        frame = requestAnimationFrame(tick);
      };
      tick();
      analyserStopRef.current = () => {
        cancelAnimationFrame(frame);
        void audioContext.close();
      };
      setMicTesting(true);
      await refreshDevices(false);
      setStatus({ key: 'settings.voiceVideo.msg.micRunning' });
    } catch (err) {
      setStatus({ key: 'settings.voiceVideo.msg.micFailed', params: { error: (err as Error).message } });
      stopMicTest();
    }
  }

  async function testOutput() {
    try {
      setVoiceTestState('output', true);
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.frequency.value = 660;
      gain.gain.value = Math.max(0.02, prefs.outputVolume / 100) * 0.08;
      oscillator.connect(gain).connect(destination);
      const audio = new Audio();
      audio.srcObject = destination.stream;
      const maybeSink = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
      const canPickOutput = typeof maybeSink.setSinkId === 'function';
      if (canPickOutput && prefs.outputDeviceId !== 'default') {
        await maybeSink.setSinkId(prefs.outputDeviceId);
      }
      oscillator.start();
      await audio.play();
      window.setTimeout(() => {
        oscillator.stop();
        void audioContext.close();
        audio.srcObject = null;
        setVoiceTestState('output', false);
      }, 450);
      setStatus({
        key: canPickOutput ? 'settings.voiceVideo.msg.outputPlayed' : 'settings.voiceVideo.msg.outputPlayedDefault',
      });
    } catch (err) {
      setVoiceTestState('output', false);
      setStatus({ key: 'settings.voiceVideo.msg.outputFailed', params: { error: (err as Error).message } });
    }
  }

  return (
    <SettingsShell scope="user">
      <section className="max-w-5xl mx-auto pb-32 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-8">
          <header>
            <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.voiceVideo')}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t('settings.voiceVideo.description')}</p>
          </header>

          <Section title={t('settings.voiceVideo.devices.title')}>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => void refreshDevices(true)} className="btn-primary-sm">
                {t('settings.voiceVideo.devices.grant')}
              </button>
              <button type="button" onClick={() => void refreshDevices(false)} className="btn-secondary-sm">
                {t('settings.voiceVideo.devices.refresh')}
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <SelectField label={t('settings.voiceVideo.devices.input')} value={prefs.inputDeviceId} options={inputs} onChange={(value) => patchDevice('input', value)} />
              <SelectField label={t('settings.voiceVideo.devices.output')} value={prefs.outputDeviceId} options={outputs} onChange={(value) => patchDevice('output', value)} />
              <SelectField label={t('settings.voiceVideo.devices.camera')} value={prefs.cameraDeviceId} options={cameras} onChange={(value) => patchDevice('camera', value)} />
            </div>
          </Section>

          <Section title={t('settings.voiceVideo.audio.title')}>
            <div className="space-y-4">
              <VolumeRow label={t('settings.voiceVideo.audio.inputVolume')} value={prefs.inputVolume} onChange={(value) => patch({ inputVolume: value })} />
              <VolumeRow label={t('settings.voiceVideo.audio.outputVolume')} value={prefs.outputVolume} onChange={(value) => patch({ outputVolume: value })} />
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => void toggleMicTest()} className="btn-secondary-sm">
                  {t(micTesting ? 'settings.voiceVideo.audio.stopMicTest' : 'settings.voiceVideo.audio.testMic')}
                </button>
                <button type="button" onClick={() => void testOutput()} className="btn-secondary-sm">
                  {t('settings.voiceVideo.audio.testOutput')}
                </button>
              </div>
              <MicLevel value={micTesting ? micLevel : prefs.inputVolume} />
            </div>
          </Section>

          <Section title={t('settings.voiceVideo.mode.title')}>
            <div className="space-y-3">
              <RadioCard label={t('settings.voiceVideo.mode.voiceActivity')} description={t('settings.voiceVideo.mode.voiceActivityHint')} checked={prefs.inputMode === 'voice_activity'} onSelect={() => patch({ inputMode: 'voice_activity' })} />
              <RadioCard label={t('settings.voiceVideo.mode.pushToTalk')} description={t('settings.voiceVideo.mode.pushToTalkHint')} checked={prefs.inputMode === 'push_to_talk'} onSelect={() => patch({ inputMode: 'push_to_talk' })} />
            </div>
            <ToggleRow label={t('settings.voiceVideo.mode.autoSensitivity')} checked={prefs.autoSensitivity} onChange={(value) => patch({ autoSensitivity: value })} />
            <div className={prefs.autoSensitivity ? 'opacity-50 pointer-events-none' : ''}>
              <VolumeRow label={t('settings.voiceVideo.mode.sensitivity')} value={prefs.sensitivity} onChange={(value) => patch({ sensitivity: value })} />
            </div>
          </Section>

          <Section title={t('settings.voiceVideo.processing.title')}>
            <ToggleRow label={t('settings.voiceVideo.processing.noise')} checked={prefs.noiseSuppression} onChange={(value) => patch({ noiseSuppression: value })} />
            <ToggleRow label={t('settings.voiceVideo.processing.echo')} checked={prefs.echoCancellation} onChange={(value) => patch({ echoCancellation: value })} />
            <ToggleRow label={t('settings.voiceVideo.processing.gain')} checked={prefs.automaticGainControl} onChange={(value) => patch({ automaticGainControl: value })} />
            <ToggleRow label={t('settings.voiceVideo.processing.isolation')} description={t('settings.voiceVideo.processing.isolationHint')} checked={prefs.voiceIsolation} onChange={(value) => patch({ voiceIsolation: value })} last />
          </Section>

          <Section title={t('settings.voiceVideo.camera.title')}>
            <div className="aspect-video bg-black rounded-xl border border-border-strong overflow-hidden flex items-center justify-center">
              <video ref={previewRef} muted playsInline autoPlay className={cameraOn ? 'w-full h-full object-cover' : 'hidden'} />
              {!cameraOn ? (
                <div className="flex flex-col items-center gap-3 text-text-muted">
                  <span className="material-symbols-outlined text-5xl">videocam_off</span>
                  <span className="text-sm">{t('settings.voiceVideo.camera.off')}</span>
                </div>
              ) : null}
            </div>
            <button type="button" onClick={() => void toggleCameraPreview()} className="btn-secondary-sm">
              {t(cameraOn ? 'settings.voiceVideo.camera.stop' : 'settings.voiceVideo.camera.start')}
            </button>
          </Section>

          <Section title={t('settings.voiceVideo.screen.title')}>
            <div className="grid sm:grid-cols-2 gap-4">
              <NativeSelect label={t('settings.voiceVideo.screen.quality')} value={prefs.screenQuality} onChange={(value) => patch({ screenQuality: value as ScreenQuality })} options={
                SCREEN_QUALITIES.map((value) => ({ value, label: screenQualityLabel(value, t) }))
              } />
              <NativeSelect label={t('settings.voiceVideo.screen.fps')} value={prefs.screenFps} onChange={(value) => patch({ screenFps: value as ScreenFps })} options={[
                { value: '15', label: '15 FPS' },
                { value: '30', label: '30 FPS' },
                { value: '60', label: '60 FPS' },
              ]} />
            </div>
            <ToggleRow label={t('settings.voiceVideo.screen.systemAudio')} checked={prefs.shareSystemAudio} onChange={(value) => patch({ shareSystemAudio: value })} last />
          </Section>

          <SettingsStickyFooter
            status={status}
            updatedAt={updatedAt}
            dirty={dirty}
            busy={busy}
            onReset={reset}
            onSave={save}
            saveDisabled={disabled}
          />
        </div>

        <aside className="lg:col-span-4">
          <div className="sticky top-8 space-y-4">
            <h3 className="text-xs uppercase tracking-wider font-bold text-text-secondary border-b border-border-subtle pb-2">
              {t('settings.voiceVideo.status.title')}
            </h3>
            <div className="rounded-2xl border border-border-strong bg-surface/80 backdrop-blur-md p-6 space-y-4 shadow-xl shadow-black/40">
              <StatusRow label={t('settings.voiceVideo.status.micPermission')} value={t(PERMISSION_LABEL_KEYS[permission])} tone={permission === 'denied' ? 'danger' : 'success'} />
              <StatusRow
                label={t('settings.voiceVideo.devices.input')}
                value={savedDeviceLabel(prefs.inputDeviceLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.inputDeviceLabel, t('settings.voiceVideo.devices.defaultMicrophone'))}
                tone="success"
              />
              <StatusRow
                label={t('settings.voiceVideo.devices.output')}
                value={savedDeviceLabel(prefs.outputDeviceLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.outputDeviceLabel, t('settings.voiceVideo.devices.defaultSpeakers'))}
                tone="success"
              />
              <StatusRow
                label={t('settings.voiceVideo.devices.camera')}
                value={savedDeviceLabel(prefs.cameraLabel, DEFAULT_VOICE_VIDEO_PREFERENCES.cameraLabel, t('settings.voiceVideo.devices.defaultCamera'))}
                tone="success"
              />
              <StatusRow
                label={t('settings.voiceVideo.status.screenShare')}
                value={t('settings.voiceVideo.status.screenSummary', { quality: screenQualityLabel(prefs.screenQuality, t), fps: prefs.screenFps })}
                tone="muted"
              />
            </div>
          </div>
        </aside>
      </section>
    </SettingsShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">{title}</h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-4">{children}</div>
    </section>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: DeviceOption[]; onChange: (value: string) => void }) {
  const t = useT();
  const rows = options.length ? options : [{ deviceId: value || 'default', label: t('settings.voiceVideo.devices.default') }];
  return <NativeSelect label={label} value={value || rows[0]!.deviceId} onChange={onChange} options={rows.map((row) => ({ value: row.deviceId, label: row.label }))} />;
}

function NativeSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs text-text-muted mb-1.5">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary">
        {options.map((option) => <option key={`${option.value}:${option.label}`} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function VolumeRow({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div>
      <div className="flex justify-between mb-1.5">
        <label className="text-xs text-text-muted">{label}</label>
        <span className="text-xs text-text-primary">{value}%</span>
      </div>
      <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-primary" aria-label={label} />
    </div>
  );
}

function MicLevel({ value }: { value: number }) {
  return (
    <div className="h-2 bg-surface-container rounded-full overflow-hidden">
      <div className="h-full bg-success transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}

function RadioCard({ label, description, checked, onSelect }: { label: string; description: string; checked: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className={`flex items-center w-full text-left p-3 rounded-lg border transition-colors ${checked ? 'bg-primary/5 border-primary/40' : 'bg-surface-raised border-border-strong hover:bg-surface-container'}`}>
      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center mr-3 ${checked ? 'border-primary' : 'border-border-strong'}`}>{checked ? <span className="w-2 h-2 bg-primary rounded-full" /> : null}</span>
      <span><span className="block text-sm text-text-primary">{label}</span><span className="block text-xs text-text-muted">{description}</span></span>
    </button>
  );
}

function ToggleRow({ label, description, checked, onChange, last = false }: { label: string; description?: string; checked: boolean; onChange: (value: boolean) => void; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${last ? '' : 'pb-3 border-b border-border-subtle'}`}>
      <div><p className="text-sm text-text-primary">{label}</p>{description ? <p className="text-xs text-text-muted">{description}</p> : null}</div>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-success' : 'bg-surface-container-highest'}`}>
        <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${checked ? 'right-1' : 'left-1 bg-text-muted'}`} />
      </button>
    </div>
  );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: 'success' | 'danger' | 'muted' }) {
  const colorClass = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-muted';
  return <div className="flex items-center justify-between gap-3"><span className="text-xs text-text-muted">{label}</span><span className={`text-xs font-medium truncate ${colorClass}`} title={value}>{value}</span></div>;
}
