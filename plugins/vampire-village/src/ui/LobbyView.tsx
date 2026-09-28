import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Panel,
  Row,
  SectionLabel,
  SegmentedControl,
  Stack,
  TextField,
  lf,
} from '@lobbyforge/plugin-sdk/ui';
import { MAX_PLAYERS, MIN_PLAYERS, NAME_MAX_LENGTH, PLAYER_COLORS } from '../state';
import type { VillageAction, VillageColor, VillageRole, VillageSettings } from '../state';
import { rolesForPlayerCount } from '../rules';
import { startBlockers, type VillageView } from '../view';
import { CloseIcon, PeopleIcon } from './icons';
import { COLOR_NAME, ROLE_NAME } from './labels';
import { Columns, VillagerChip, namer } from './pieces';
import { useText } from './text';
import { COLOR_HEX } from './theme';

type Dispatch = (action: VillageAction) => void;

export interface LobbyViewProps {
  view: VillageView;
  dispatch: Dispatch;
  actorUserId: string;
  hostUserId: string | null;
  isHost: boolean;
  /** The viewer's display name, when the host knows it — prefills the character name. */
  displayName: string | null;
}

/** Same tidying as the reducer, so the form can warn before it is refused. */
function tidy(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function LobbyView({ view, dispatch, actorUserId, hostUserId, isHost, displayName }: LobbyViewProps) {
  const { t, list } = useText();
  const name = namer(view);
  const me = view.players.find((p) => p.id === actorUserId) ?? null;
  const [editing, setEditing] = useState(false);
  const blockers = startBlockers(view);

  const roster = (
    <Panel>
      <Stack gap={12}>
        <SectionLabel>{t('vampire.lobby.players', { count: view.players.length, max: MAX_PLAYERS })}</SectionLabel>
        {view.players.length === 0 ? (
          <EmptyState
            icon={<PeopleIcon size={36} />}
            title={t('vampire.lobby.emptyTitle')}
            body={t('vampire.lobby.emptyBody', { min: MIN_PLAYERS })}
          />
        ) : (
          <Row gap={10} wrap>
            {view.players.map((p) => {
              const parts = [p.ready ? t('vampire.lobby.tagReady') : t('vampire.lobby.tagNotReady')];
              if (p.id === hostUserId) parts.unshift(t('vampire.lobby.tagHost'));
              if (p.id === actorUserId) parts.unshift(t('vampire.lobby.tagYou'));
              const tag = parts.join(' · ');
              return (
                <VillagerChip
                  key={p.id}
                  player={p}
                  tag={tag}
                  tagTone={p.ready ? 'success' : 'neutral'}
                  highlight={p.id === actorUserId}
                  trailing={
                    isHost && p.id !== actorUserId ? (
                      <button
                        type="button"
                        className="lfui-btn lfui-btn-quiet lfui-focus"
                        aria-label={t('vampire.lobby.kick', { name: p.name })}
                        title={t('vampire.lobby.kick', { name: p.name })}
                        onClick={() => dispatch({ type: 'kick', targetId: p.id })}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 99,
                          border: 0,
                          padding: 0,
                          background: 'transparent',
                          color: lf.muted,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <CloseIcon />
                      </button>
                    ) : null
                  }
                />
              );
            })}
          </Row>
        )}
        {view.spectators.length > 0 ? (
          <span style={{ fontSize: 13, color: lf.muted }}>
            {t('vampire.lobby.watching', { names: list(view.spectators.map((s) => s.name)) })}
          </span>
        ) : null}
      </Stack>
    </Panel>
  );

  const start = isHost ? (
    <Panel highlight={blockers ? undefined : 'game'}>
      <Stack gap={10}>
        <Button variant="game" size="lg" disabled={blockers !== null} onClick={() => dispatch({ type: 'start' })}>
          {t('vampire.lobby.start')}
        </Button>
        {blockers ? (
          <span role="status" style={{ fontSize: 14, color: lf.text2 }}>
            {blockers.needPlayers > 0
              ? t('vampire.lobby.needPlayers', { count: blockers.needPlayers })
              : t('vampire.lobby.waitingReady', { names: list(blockers.waitingFor.map(name)) })}
          </span>
        ) : null}
      </Stack>
    </Panel>
  ) : (
    <Callout tone="info" role="status">
      {t('vampire.lobby.waitingHost')}
    </Callout>
  );

  return (
    <Columns
      main={
        <>
          {me && !editing ? (
            <Panel highlight={me.ready ? 'success' : undefined}>
              <Row justify="space-between" wrap gap={14}>
                <Row gap={12}>
                  <Avatar name={me.name} size={44} tint={COLOR_HEX[me.color]} />
                  <Stack gap={2}>
                    <span style={{ fontSize: 17, fontWeight: 600 }}>{me.name}</span>
                    <span style={{ fontSize: 13, color: lf.text2 }}>
                      {me.ready ? t('vampire.lobby.tagReady') : t('vampire.lobby.tagNotReady')}
                    </span>
                  </Stack>
                </Row>
                <Row gap={8} wrap>
                  <Button
                    variant={me.ready ? 'success' : 'game'}
                    aria-pressed={me.ready}
                    onClick={() => dispatch({ type: 'set-ready', playerId: actorUserId, ready: !me.ready })}
                  >
                    {t('vampire.lobby.ready')}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(true)}>
                    {t('vampire.lobby.edit')}
                  </Button>
                  <Button variant="ghost" onClick={() => dispatch({ type: 'leave', playerId: actorUserId })}>
                    {t('vampire.lobby.leave')}
                  </Button>
                </Row>
              </Row>
            </Panel>
          ) : (
            <CharacterForm
              view={view}
              dispatch={dispatch}
              actorUserId={actorUserId}
              initialName={me?.name ?? displayName ?? ''}
              initialColor={me?.color ?? null}
              editing={editing}
              onDone={() => setEditing(false)}
            />
          )}
          {roster}
          {start}
        </>
      }
      side={
        <>
          <TimerSettings view={view} dispatch={dispatch} editable={isHost} title={t('vampire.lobby.timers')} />
          <RolesPreview view={view} />
          <Rules />
        </>
      }
    />
  );
}

function CharacterForm({
  view,
  dispatch,
  actorUserId,
  initialName,
  initialColor,
  editing,
  onDone,
}: {
  view: VillageView;
  dispatch: Dispatch;
  actorUserId: string;
  initialName: string;
  initialColor: VillageColor | null;
  editing: boolean;
  onDone: () => void;
}) {
  const { t } = useText();
  const [draft, setDraft] = useState(initialName);
  const taken = new Set(view.players.filter((p) => p.id !== actorUserId).map((p) => p.color));
  const [color, setColor] = useState<VillageColor>(
    initialColor ?? PLAYER_COLORS.find((c) => !taken.has(c)) ?? PLAYER_COLORS[0]
  );
  const clean = tidy(draft);
  const lower = clean.toLowerCase();
  const nameTaken = clean.length > 0 && view.players.some((p) => p.id !== actorUserId && p.name.toLowerCase() === lower);
  const tooLong = clean.length > NAME_MAX_LENGTH;
  const error = nameTaken
    ? t('vampire.lobby.nameTaken')
    : tooLong
      ? t('vampire.lobby.nameTooLong', { max: NAME_MAX_LENGTH })
      : null;
  const full = !view.players.some((p) => p.id === actorUserId) && view.players.length >= MAX_PLAYERS;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!clean || error) return;
    dispatch({ type: 'join', playerId: actorUserId, name: clean, color });
    onDone();
  };

  return (
    <Panel highlight={editing ? undefined : 'game'}>
      <form onSubmit={submit}>
        <Stack gap={14}>
          <SectionLabel>{editing ? t('vampire.lobby.editTitle') : t('vampire.lobby.createTitle')}</SectionLabel>
          {full ? (
            <Callout tone="info" role="status">
              {t('vampire.lobby.full')}
            </Callout>
          ) : null}
          <TextField
            label={t('vampire.lobby.nameLabel')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('vampire.lobby.namePlaceholder')}
            maxLength={NAME_MAX_LENGTH + 8}
            autoComplete="off"
            error={error}
          />
          <ColorPicker value={color} onChange={setColor} />
          <Row gap={8} wrap>
            <Button type="submit" variant="game" disabled={!clean || error !== null}>
              {editing ? t('vampire.lobby.save') : t('vampire.lobby.join')}
            </Button>
            {editing ? (
              <Button variant="ghost" onClick={onDone}>
                {t('vampire.lobby.cancel')}
              </Button>
            ) : null}
          </Row>
        </Stack>
      </form>
    </Panel>
  );
}

/** A radio group of colour swatches, with arrow-key navigation (roving tab stop). */
function ColorPicker({ value, onChange }: { value: VillageColor; onChange: (color: VillageColor) => void }) {
  const { t } = useText();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const label = t('vampire.lobby.colorLabel');
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = (PLAYER_COLORS.indexOf(value) + step + PLAYER_COLORS.length) % PLAYER_COLORS.length;
    const next = PLAYER_COLORS[index]!;
    onChange(next);
    refs.current[index]?.focus();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 500, color: lf.text2 }}>
        {label}
      </span>
      <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {PLAYER_COLORS.map((c, i) => (
          <button
            key={c}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === c}
            tabIndex={value === c ? 0 : -1}
            aria-label={t(COLOR_NAME[c])}
            title={t(COLOR_NAME[c])}
            className="vv-swatch lfui-focus"
            style={{ background: COLOR_HEX[c] }}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  );
}

const NIGHT_OPTIONS = [20, 30, 45, 60];
const DAY_OPTIONS = [60, 90, 120, 180];
const VOTE_OPTIONS = [20, 30, 45, 60];

/** Timer presets; the current value always appears, even a custom one. */
export function TimerSettings({
  view,
  dispatch,
  editable,
  title,
}: {
  view: VillageView;
  dispatch: Dispatch;
  editable: boolean;
  title: string;
}) {
  const { t } = useText();
  const row = (label: string, key: keyof VillageSettings, presets: number[]) => {
    const current = view.settings[key];
    const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
    return (
      <Stack gap={6}>
        <span style={{ fontSize: 13, fontWeight: 500, color: lf.text2 }}>{label}</span>
        <SegmentedControl
          label={label}
          value={String(current)}
          disabled={!editable}
          options={values.map((v) => ({ value: String(v), label: t('vampire.lobby.seconds', { count: v }) }))}
          onChange={(v) => dispatch({ type: 'configure', settings: { [key]: Number(v) } as Partial<VillageSettings> })}
        />
      </Stack>
    );
  };
  return (
    <Panel>
      <Stack gap={12}>
        <SectionLabel>{title}</SectionLabel>
        {row(t('vampire.lobby.nightTimer'), 'nightSeconds', NIGHT_OPTIONS)}
        {row(t('vampire.lobby.dayTimer'), 'daySeconds', DAY_OPTIONS)}
        {row(t('vampire.lobby.voteTimer'), 'votingSeconds', VOTE_OPTIONS)}
      </Stack>
    </Panel>
  );
}

function RolesPreview({ view }: { view: VillageView }) {
  const { t } = useText();
  const seated = view.players.length;
  const count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, seated));
  const roles = rolesForPlayerCount(count);
  const tally = new Map<VillageRole, number>();
  for (const role of roles) tally.set(role, (tally.get(role) ?? 0) + 1);
  return (
    <Panel variant="raised">
      <Stack gap={10}>
        <SectionLabel>{t('vampire.lobby.rolesTitle')}</SectionLabel>
        <span style={{ fontSize: 14, color: lf.text2 }}>
          {seated >= MIN_PLAYERS
            ? t('vampire.lobby.rolesFor', { count })
            : t('vampire.lobby.rolesRange', { min: MIN_PLAYERS, max: MAX_PLAYERS })}
        </span>
        <Row gap={8} wrap>
          {[...tally.entries()].map(([role, n]) => (
            <Badge key={role} tone={role === 'vampire' ? 'danger' : role === 'survivor' || role === 'jester' ? 'info' : 'success'}>
              {n > 1 ? `${n} × ${t(ROLE_NAME[role])}` : t(ROLE_NAME[role])}
            </Badge>
          ))}
        </Row>
      </Stack>
    </Panel>
  );
}

function Rules() {
  const { t } = useText();
  return (
    <Panel variant="raised">
      <details>
        <summary className="lfui-focus" style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
          {t('vampire.lobby.rulesTitle')}
        </summary>
        <ol style={{ margin: '12px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>
          <li>{t('vampire.lobby.rule1')}</li>
          <li>{t('vampire.lobby.rule2')}</li>
          <li>{t('vampire.lobby.rule3')}</li>
          <li>{t('vampire.lobby.rule4')}</li>
        </ol>
      </details>
    </Panel>
  );
}
