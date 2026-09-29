/**
 * Pieces shared by the phase views. Built from the kit; the few things the
 * kit does not have (a text field, a colour-ringed player chip, a big
 * target button, a chat box) are local and use the kit's tokens.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Avatar, Badge, Button, Panel, Row, SectionLabel, Stack, TextField, lf, tone, type Tone } from '@lobbyforge/plugin-sdk/ui';
import { CHAT_MAX_LENGTH } from '../state';
import type { VillageChatMessage, VillageLogEntry, VillageNote, VillagePlayer } from '../state';
import { teamOf } from '../rules';
import type { VillageView } from '../view';
import { RoleIcon, SendIcon, SkullIcon } from './icons';
import { CAUSE_NEWS, CAUSE_TAG, ROLE_BLURB, ROLE_NAME, TEAM_NAME, goalKey } from './labels';
import { useText, type Translate } from './text';
import { COLOR_HEX, ROSE } from './theme';

/** id → character name (spectators too); an unknown id shows a short form of itself. */
export function namer(view: Pick<VillageView, 'players' | 'spectators'>): (id: string | null | undefined) => string {
  return (id) => {
    if (!id) return '';
    const found = view.players.find((p) => p.id === id) ?? view.spectators.find((s) => s.id === id);
    return found?.name ?? id.slice(0, 8);
  };
}

export const isNightPhase = (phase: VillageView['phase']) => phase === 'night' || phase === 'role_reveal';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** A player chip ringed and tinted with the character's chosen colour (spec §6). */
export function VillagerChip({
  player,
  tag,
  tagTone = 'neutral',
  trailing,
  highlight = false,
}: {
  player: VillagePlayer;
  tag?: ReactNode;
  tagTone?: Tone;
  trailing?: ReactNode;
  highlight?: boolean;
}) {
  const out = !player.alive;
  return (
    <span
      style={{
        minHeight: 44,
        boxSizing: 'border-box',
        padding: '4px 12px 4px 5px',
        borderRadius: 99,
        background: lf.raised,
        border: `1px solid ${highlight ? tone('accent').line : lf.border}`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        opacity: out ? 0.6 : 1,
        maxWidth: '100%',
      }}
    >
      <Avatar name={player.name} tint={COLOR_HEX[player.color]} />
      <span
        style={{
          fontSize: 14,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textDecoration: out ? 'line-through' : 'none',
        }}
      >
        {player.name}
      </span>
      {tag ? (
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: tone(tagTone).text }}>
          {tag}
        </span>
      ) : null}
      {trailing}
    </span>
  );
}

/** A big square pick for the night grid: avatar, name and a short status tag. */
export function TargetButton({
  player,
  label,
  selected,
  tag,
  onPick,
  disabled = false,
}: {
  player: VillagePlayer;
  /** The accessible name, e.g. "Protect Ada". */
  label: string;
  selected: boolean;
  tag?: ReactNode;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="vv-target lfui-option lfui-focus"
      aria-pressed={selected}
      aria-label={label}
      onClick={onPick}
      disabled={disabled}
    >
      <Avatar name={player.name} size={40} tint={COLOR_HEX[player.color]} />
      <span style={{ fontSize: 14, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {player.name}
      </span>
      <span
        aria-hidden="true"
        style={{ minHeight: 14, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--lfui-accent-text)' }}
      >
        {tag}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The viewer's role
// ---------------------------------------------------------------------------

export function RoleCard({ view, hint }: { view: VillageView; hint?: ReactNode }) {
  const { t, list } = useText();
  const me = view.me;
  if (!me) return null;
  const name = namer(view);
  const team = teamOf(me.role);
  const night = isNightPhase(view.phase);
  const packmates = me.pack ? me.pack.members.filter((id) => id !== me.id) : null;
  const heading = t(ROLE_NAME[me.role]);
  return (
    <section aria-label={t('vampire.card.yourRole')} style={{ minWidth: 0 }}>
      <Panel variant="raised" highlight={night ? 'accent' : undefined} padding={22} radius={22}>
        <Stack gap={12}>
          <Row justify="space-between" wrap>
            <SectionLabel>{t('vampire.card.yourRole')}</SectionLabel>
            {!me.alive ? <Badge tone="danger">{t('vampire.card.out')}</Badge> : null}
          </Row>
          <Row gap={10}>
            <span style={{ color: night ? ROSE.text : tone('game').text, display: 'inline-flex' }}>
              <RoleIcon role={me.role} size={28} />
            </span>
            <h3 style={{ margin: 0, fontSize: 30, fontWeight: 800, letterSpacing: '-0.01em', color: night ? ROSE.text : lf.text }}>
              {heading}
            </h3>
          </Row>
          <span style={{ fontSize: 14, lineHeight: 1.55, color: lf.text2 }}>{t(ROLE_BLURB[me.role])}</span>
          <span style={{ fontSize: 13, color: lf.muted }}>
            {t('vampire.card.team', { team: t(TEAM_NAME[team]) })} · {t(goalKey(me.role, team))}
          </span>
          {packmates !== null ? (
            <div style={{ padding: 12, borderRadius: 14, background: lf.sunken, fontSize: 13, color: lf.text2 }}>
              {packmates.length > 0
                ? t('vampire.card.pack', { names: list(packmates.map(name)) })
                : t('vampire.card.packAlone')}
            </div>
          ) : null}
          <Resources view={view} />
          {hint ? <span style={{ fontSize: 13, color: lf.muted }}>{hint}</span> : null}
        </Stack>
      </Panel>
    </section>
  );
}

function Resources({ view }: { view: VillageView }) {
  const { t } = useText();
  const me = view.me;
  if (!me || !me.alive) return null;
  const name = namer(view);
  const bits: ReactNode[] = [];
  if (me.role === 'hunter') bits.push(<Badge key="b" tone="game">{t('vampire.card.bullets', { count: me.resources.bullets ?? 0 })}</Badge>);
  if (me.role === 'survivor') bits.push(<Badge key="s" tone="info">{t('vampire.card.shields', { count: me.resources.shields ?? 0 })}</Badge>);
  const last = me.role === 'doctor' ? me.resources.lastProtectedId : null;
  if (bits.length === 0 && !last) return null;
  return (
    <Stack gap={8}>
      {bits.length ? <Row gap={8} wrap>{bits}</Row> : null}
      {last ? <span style={{ fontSize: 13, color: lf.text2 }}>{t('vampire.card.lastProtected', { name: name(last) })}</span> : null}
    </Stack>
  );
}

/** One private note, as a sentence. */
export function noteText(note: VillageNote, t: Translate, name: (id: string) => string): string {
  switch (note.kind) {
    case 'inspected':
      return t('vampire.note.inspected', { round: note.round, name: name(note.targetId), role: t(ROLE_NAME[note.role]) });
    case 'protected':
      return t(note.attacked ? 'vampire.note.protectedSaved' : 'vampire.note.protected', {
        round: note.round,
        name: name(note.targetId),
      });
    case 'survived':
      return t('vampire.note.survived', { round: note.round });
    case 'shot': {
      const line = t(note.result === 'killed' ? 'vampire.note.shotKilled' : 'vampire.note.shotBlocked', {
        round: note.round,
        name: name(note.targetId),
      });
      return note.remorse ? `${line} ${t('vampire.note.remorse', { name: name(note.targetId) })}` : line;
    }
    case 'shielded':
      return t(note.attacked ? 'vampire.note.shieldedSaved' : 'vampire.note.shielded', { round: note.round });
    default:
      return '';
  }
}

/** "What only you know": the viewer's private notes, newest first. */
export function PrivateNotes({ view, limit }: { view: VillageView; limit?: number }) {
  const { t } = useText();
  const notes = view.me?.notes ?? [];
  if (notes.length === 0) return null;
  const name = namer(view);
  const shown = [...notes].reverse().slice(0, limit ?? notes.length);
  return (
    <Panel variant="raised" padding={18}>
      <Stack gap={8}>
        <SectionLabel>{t('vampire.card.learned')}</SectionLabel>
        <ul className="vv-list">
          {shown.map((note, i) => (
            <li key={`${note.round}-${note.kind}-${i}`} style={{ fontSize: 14, lineHeight: 1.5, color: lf.text }}>
              {noteText(note, t, name)}
            </li>
          ))}
        </ul>
      </Stack>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// News, the log and the list of the dead
// ---------------------------------------------------------------------------

/** One public log entry as a sentence (or null for entries shown elsewhere). */
export function logText(entry: VillageLogEntry, t: Translate, name: (id: string) => string): string | null {
  switch (entry.kind) {
    case 'game-start':
      return t('vampire.log.start', { players: entry.players, count: entry.vampires });
    case 'death':
      return `${t(CAUSE_NEWS[entry.cause], { name: name(entry.playerId) })} ${t('vampire.news.role', { role: t(ROLE_NAME[entry.role]) })}`;
    case 'quiet-night':
      return t('vampire.news.quiet');
    case 'attack-stopped':
      return t('vampire.news.stopped', { count: entry.count });
    case 'vote-result': {
      if (entry.hangedId !== null) return `${t('vampire.pill.voting')}: ${tallyText(entry.votes, t, name)}`;
      const tally = tallyText(entry.votes, t, name);
      return tally ? `${t('vampire.news.noHanging')} (${tally})` : t('vampire.news.noHanging');
    }
    case 'jester-win':
      return t('vampire.news.jester', { name: name(entry.playerId) });
    case 'game-over':
      return entry.winner === 'village'
        ? t('vampire.end.village')
        : entry.winner === 'vampires'
          ? t('vampire.end.vampires')
          : t('vampire.end.none');
    default:
      return null;
  }
}

/** "Theo 4 · Kaya 1 · no one 1" — most votes first. */
export function tallyText(votes: Record<string, string | null>, t: Translate, name: (id: string) => string): string {
  const counts = new Map<string, number>();
  let skip = 0;
  for (const target of Object.values(votes)) {
    if (target === null) skip += 1;
    else counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${name(id)} ${n}`);
  if (skip > 0) parts.push(`${t('vampire.log.noOne')} ${skip}`);
  return parts.join(' · ');
}

/** The dawn announcement / verdict: big, one event per line. */
export function NewsList({ entries, view }: { entries: VillageLogEntry[]; view: VillageView }) {
  const { t } = useText();
  const name = namer(view);
  return (
    <ul className="vv-list" style={{ gap: 12 }}>
      {entries.map((entry) => {
        const dead = entry.kind === 'death';
        return (
          <li key={entry.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span aria-hidden="true" style={{ color: dead ? tone('danger').text : lf.muted, paddingTop: 2 }}>
              {dead ? <SkullIcon size={20} /> : null}
            </span>
            <span style={{ fontSize: dead ? 17 : 15, lineHeight: 1.5, fontWeight: dead ? 600 : 400 }}>{logText(entry, t, name)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** "Out of the game": every dead player with their revealed role (spec §13). */
export function OutList({ view }: { view: VillageView }) {
  const { t } = useText();
  const dead = view.players.filter((p) => !p.alive && p.death);
  return (
    <Panel variant="raised" padding={18}>
      <Stack gap={10}>
        <SectionLabel>{t('vampire.day.out')}</SectionLabel>
        {dead.length === 0 ? (
          <span style={{ fontSize: 14, color: lf.text2 }}>{t('vampire.day.outEmpty')}</span>
        ) : (
          <ul className="vv-list">
            {dead.map((p) => {
              const death = p.death!;
              const when = t(death.time === 'night' ? 'vampire.day.whenNight' : 'vampire.day.whenDay', { round: death.round });
              return (
                <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 14, color: lf.text2 }}>
                  <span>{t('vampire.day.outLine', { name: p.name, role: t(ROLE_NAME[death.role]), when })}</span>
                  <Badge tone="danger">{t(CAUSE_TAG[death.cause])}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Stack>
    </Panel>
  );
}

/** The public event log, grouped by night and day (spec §14). */
export function LogPanel({ view }: { view: VillageView }) {
  const { t } = useText();
  const name = namer(view);
  const groups: Array<{ key: string; label: string | null; lines: Array<{ id: number; text: string }> }> = [];
  for (const entry of view.log) {
    const text = logText(entry, t, name);
    if (!text) continue;
    const label =
      entry.time === 'setup'
        ? null
        : t(entry.time === 'night' ? 'vampire.log.night' : 'vampire.log.day', { round: entry.round });
    const key = `${entry.time}-${entry.round}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.lines.push({ id: entry.id, text });
    else groups.push({ key, label, lines: [{ id: entry.id, text }] });
  }
  return (
    <Panel variant="raised" padding={18}>
      <Stack gap={10}>
        <SectionLabel>{t('vampire.log.title')}</SectionLabel>
        {groups.length === 0 ? (
          <span style={{ fontSize: 14, color: lf.text2 }}>{t('vampire.log.empty')}</span>
        ) : (
          <div className="vv-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map((group) => (
              <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {group.label ? (
                  <span style={{ fontSize: 12, fontWeight: 600, color: lf.muted }}>{group.label}</span>
                ) : null}
                {group.lines.map((line) => (
                  <span key={line.id} style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>
                    {line.text}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </Stack>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Inputs and chat
// ---------------------------------------------------------------------------

export function ChatBox({
  view,
  title,
  messages,
  emptyText,
  canWrite,
  closedText,
  left,
  label,
  placeholder,
  onSend,
}: {
  view: VillageView;
  title: string;
  messages: VillageChatMessage[];
  emptyText: string;
  canWrite: boolean;
  closedText?: string | null;
  /** "8 messages left", or null. */
  left?: string | null;
  label: string;
  placeholder: string;
  onSend: (text: string) => void;
}) {
  const { t } = useText();
  const name = namer(view);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const lastId = messages.length ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.replace(/\s+/g, ' ').trim();
    if (!text) return;
    onSend(text.slice(0, CHAT_MAX_LENGTH));
    setDraft('');
  };
  const own = view.me?.id;
  return (
    <Panel variant="raised" padding={16} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <SectionLabel>{title}</SectionLabel>
      <div ref={scroller} role="log" aria-label={title} className="vv-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 48 }}>
        {messages.length === 0 ? (
          <span style={{ fontSize: 14, color: lf.muted }}>{emptyText}</span>
        ) : (
          messages.map((m) => (
            <p key={m.id} style={{ margin: 0, fontSize: 14, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              <span style={{ fontWeight: 600, color: 'var(--lfui-accent-text)' }}>
                {m.authorId === own ? t('vampire.chat.you') : name(m.authorId)}
              </span>{' '}
              {m.text}
            </p>
          ))
        )}
      </div>
      {canWrite ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Row gap={8} align="flex-end">
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <TextField
                label={label}
                hideLabel
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                maxLength={CHAT_MAX_LENGTH}
                autoComplete="off"
              />
            </div>
            <Button type="submit" aria-label={t('vampire.chat.send')} disabled={!draft.trim()}>
              <SendIcon />
            </Button>
          </Row>
          {left ? <span style={{ fontSize: 12, color: lf.muted }}>{left}</span> : null}
        </form>
      ) : closedText ? (
        <span style={{ fontSize: 13, color: lf.muted }}>{closedText}</span>
      ) : null}
    </Panel>
  );
}

/** Two flexible columns that stack when the centre column is narrow. */
export function Columns({ main, side, mainBasis = 420, sideBasis = 300 }: { main: ReactNode; side: ReactNode; mainBasis?: number; sideBasis?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start', minWidth: 0 }}>
      <div style={{ flex: `2 1 ${mainBasis}px`, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>{main}</div>
      <div style={{ flex: `1 1 ${sideBasis}px`, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>{side}</div>
    </div>
  );
}
