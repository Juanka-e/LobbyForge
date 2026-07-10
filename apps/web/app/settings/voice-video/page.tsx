'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';
import {
  DEFAULT_VOICE_VIDEO_PREFERENCES,
  mergeVoiceVideoPreferences,
  type ScreenFps,
  type ScreenQuality,
  type VoiceVideoPreferences,
} from '@/lib/voice-video-preferences';

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

function uniqueDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string): DeviceOption[] {
  const seen = new Set<string>();
  const rows = devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId || 'default',
      label: deviceLabel(device, `${fallback} ${index + 1}`),
    }))
    .filter((device) => {
      const key = `${device.deviceId}:${device.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return rows.length ? rows : [{ deviceId: 'default', label: `Default ${fallback.toLowerCase()}` }];
}

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
  const [prefs, setPrefs] = useState<VoiceVideoPreferences>(DEFAULT_VOICE_VIDEO_PREFERENCES);
  const [savedSnapshot, setSavedSnapshot] = useState<VoiceVideoPreferences>(DEFAULT_VOICE_VIDEO_PREFERENCES);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading settings...');
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
      setStatus('This browser does not expose media devices.');
      return;
    }
    if (requestPermission) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(uniqueDevices(devices, 'audioinput', 'Microphone'));
    setOutputs(uniqueDevices(devices, 'audiooutput', 'Speakers'));
    setCameras(uniqueDevices(devices, 'videoinput', 'Camera'));
    setStatus(requestPermission ? 'Devices refreshed.' : 'Ready');
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
        await refreshDevices(false).catch(() => setStatus('Ready - grant media permission to reveal device names.'));
      } catch (err) {
        if (!cancelled) setStatus((err as Error).message);
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
      patch({ inputDeviceId: deviceId, inputDeviceLabel: selected?.label ?? 'Selected microphone' });
    } else if (kind === 'output') {
      patch({ outputDeviceId: deviceId, outputDeviceLabel: selected?.label ?? 'Selected speakers' });
    } else {
      patch({ cameraDeviceId: deviceId, cameraLabel: selected?.label ?? 'Selected camera' });
      if (cameraOn) void startCamera({ ...prefs, cameraDeviceId: deviceId, cameraLabel: selected?.label ?? prefs.cameraLabel });
    }
  }

  async function save() {
    setBusy(true);
    setStatus('Saving...');
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
      setStatus('Saved');
    } catch (err) {
      setStatus((err as Error).message);
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
    setStatus('Camera preview running.');
  }

  async function toggleCameraPreview() {
    try {
      if (cameraOn) {
        stopCamera();
        setStatus('Camera preview stopped.');
      } else {
        await startCamera();
        await refreshDevices(false);
      }
    } catch (err) {
      setStatus(`Camera preview failed: ${(err as Error).message}`);
    }
  }

  function stopMicTest() {
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
        setStatus('Microphone test stopped.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsForAudio(prefs), video: false });
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
      setStatus('Microphone test running. You should hear your mic at reduced volume.');
      await refreshDevices(false);
    } catch (err) {
      setStatus(`Microphone test failed: ${(err as Error).message}`);
      stopMicTest();
    }
  }

  async function testOutput() {
    try {
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
      }, 450);
      setStatus(canPickOutput ? 'Output test played.' : 'Output test played on browser default output.');
    } catch (err) {
      setStatus(`Output test failed: ${(err as Error).message}`);
    }
  }

  return (
    <SettingsShell scope="user">
      <section className="max-w-5xl mx-auto pb-32 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-8">
          <header>
            <h1 className="text-2xl font-semibold text-text-primary">Voice &amp; Video</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Choose devices, test your mic and camera, and save defaults used by voice rooms.
            </p>
          </header>

          <Section title="Devices">
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => void refreshDevices(true)} className="btn-primary-sm">
                Grant access &amp; refresh devices
              </button>
              <button type="button" onClick={() => void refreshDevices(false)} className="btn-secondary-sm">
                Refresh list
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <SelectField label="Input device" value={prefs.inputDeviceId} options={inputs} onChange={(value) => patchDevice('input', value)} />
              <SelectField label="Output device" value={prefs.outputDeviceId} options={outputs} onChange={(value) => patchDevice('output', value)} />
              <SelectField label="Camera device" value={prefs.cameraDeviceId} options={cameras} onChange={(value) => patchDevice('camera', value)} />
            </div>
          </Section>

          <Section title="Audio Test">
            <div className="space-y-4">
              <VolumeRow label="Input volume" value={prefs.inputVolume} onChange={(value) => patch({ inputVolume: value })} />
              <VolumeRow label="Output volume" value={prefs.outputVolume} onChange={(value) => patch({ outputVolume: value })} />
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => void toggleMicTest()} className="btn-secondary-sm">
                  {micTesting ? 'Stop microphone test' : 'Test microphone'}
                </button>
                <button type="button" onClick={() => void testOutput()} className="btn-secondary-sm">
                  Test output
                </button>
              </div>
              <MicLevel value={micTesting ? micLevel : prefs.inputVolume} />
            </div>
          </Section>

          <Section title="Input Mode">
            <div className="space-y-3">
              <RadioCard label="Voice activity" description="Speak freely - your mic opens while you talk." checked={prefs.inputMode === 'voice_activity'} onSelect={() => patch({ inputMode: 'voice_activity' })} />
              <RadioCard label="Push to talk" description="Hold Space while focused on the lobby to open your mic." checked={prefs.inputMode === 'push_to_talk'} onSelect={() => patch({ inputMode: 'push_to_talk' })} />
            </div>
            <ToggleRow label="Automatically determine input sensitivity" checked={prefs.autoSensitivity} onChange={(value) => patch({ autoSensitivity: value })} />
            <div className={prefs.autoSensitivity ? 'opacity-50 pointer-events-none' : ''}>
              <VolumeRow label="Sensitivity" value={prefs.sensitivity} onChange={(value) => patch({ sensitivity: value })} />
            </div>
          </Section>

          <Section title="Voice Processing">
            <ToggleRow label="Noise suppression" checked={prefs.noiseSuppression} onChange={(value) => patch({ noiseSuppression: value })} />
            <ToggleRow label="Echo cancellation" checked={prefs.echoCancellation} onChange={(value) => patch({ echoCancellation: value })} />
            <ToggleRow label="Automatic gain control" checked={prefs.automaticGainControl} onChange={(value) => patch({ automaticGainControl: value })} />
            <ToggleRow label="Voice isolation" description="Prioritize your voice over background sounds when supported." checked={prefs.voiceIsolation} onChange={(value) => patch({ voiceIsolation: value })} last />
          </Section>

          <Section title="Camera Preview">
            <div className="aspect-video bg-black rounded-xl border border-border-strong overflow-hidden flex items-center justify-center">
              <video ref={previewRef} muted playsInline autoPlay className={cameraOn ? 'w-full h-full object-cover' : 'hidden'} />
              {!cameraOn ? (
                <div className="flex flex-col items-center gap-3 text-text-muted">
                  <span className="material-symbols-outlined text-5xl">videocam_off</span>
                  <span className="text-sm">Preview is off</span>
                </div>
              ) : null}
            </div>
            <button type="button" onClick={() => void toggleCameraPreview()} className="btn-secondary-sm">
              {cameraOn ? 'Stop preview' : 'Start camera preview'}
            </button>
          </Section>

          <Section title="Screen Sharing">
            <div className="grid sm:grid-cols-2 gap-4">
              <NativeSelect label="Preferred quality" value={prefs.screenQuality} onChange={(value) => patch({ screenQuality: value as ScreenQuality })} options={[
                { value: 'auto', label: 'Auto' },
                { value: 'low', label: 'Low (480p)' },
                { value: 'standard', label: 'Standard (720p)' },
                { value: 'high', label: 'High (1080p)' },
              ]} />
              <NativeSelect label="Preferred frame rate" value={prefs.screenFps} onChange={(value) => patch({ screenFps: value as ScreenFps })} options={[
                { value: '15', label: '15 FPS' },
                { value: '30', label: '30 FPS' },
                { value: '60', label: '60 FPS' },
              ]} />
            </div>
            <ToggleRow label="Share system audio when available" checked={prefs.shareSystemAudio} onChange={(value) => patch({ shareSystemAudio: value })} last />
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
              Connection &amp; Devices
            </h3>
            <div className="rounded-2xl border border-border-strong bg-surface/80 backdrop-blur-md p-6 space-y-4 shadow-xl shadow-black/40">
              <StatusRow label="Microphone permission" value={permission} tone={permission === 'denied' ? 'danger' : 'success'} />
              <StatusRow label="Input device" value={prefs.inputDeviceLabel} tone="success" />
              <StatusRow label="Output device" value={prefs.outputDeviceLabel} tone="success" />
              <StatusRow label="Camera device" value={prefs.cameraLabel} tone="success" />
              <StatusRow label="Screen-share quality" value={`${prefs.screenQuality} / ${prefs.screenFps} FPS`} tone="muted" />
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
  const rows = options.length ? options : [{ deviceId: value || 'default', label: 'Default device' }];
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
