/**
 * "Up next": the queue, and the add-link form while a video is on screen
 * (before that, the form is the empty state's call to action).
 *
 * Queue entries have no title and no thumbnail on purpose: fetching either
 * would contact Google for every viewer who merely LOOKS at the queue, and
 * would need the CSP opened to YouTube's image host. The link is shown as
 * `youtu.be/<id>`, with "open on YouTube" for anyone who wants to check.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Badge, Button, Panel, Row, SectionLabel, lf } from '@lobbyforge/plugin-sdk/ui';
import type { WatchPartyClientAction } from '../reducer';
import type { WatchPartyItem, WatchPartyState } from '../state';
import { formatTime } from '../sync';
import { youTubeShortLabel, youTubeWatchUrl } from '../youtube';
import { AddLinkForm } from './AddLinkForm';
import { DownIcon, ExternalIcon, NextIcon, PlayIcon, RemoveIcon, UpIcon } from './icons';
import type { Translate } from './types';

const ICON_BUTTON: CSSProperties = { width: 32, minHeight: 32, padding: 0, borderRadius: 10 };

export function UpNext({
  t,
  state,
  me,
  isHost,
  nameOf,
  send,
}: {
  t: Translate;
  state: WatchPartyState;
  me: string;
  isHost: boolean;
  nameOf: (userId: string) => string;
  send: (action: WatchPartyClientAction) => void;
}) {
  const { queue } = state;
  return (
    <Panel padding={16} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Row gap={8} wrap>
        <SectionLabel>{t('watchParty.queue.title')}</SectionLabel>
        {queue.length > 0 ? <Badge>{t('watchParty.queue.count', { count: queue.length })}</Badge> : null}
        {isHost && queue.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => send({ type: 'skip' })} style={{ marginLeft: 'auto' }}>
            <NextIcon />
            {t('watchParty.queue.skip')}
          </Button>
        ) : null}
      </Row>

      {queue.length === 0 ? (
        <span style={{ fontSize: 14, color: lf.muted }}>{t('watchParty.queue.empty')}</span>
      ) : (
        <ol
          aria-label={t('watchParty.queue.title')}
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {queue.map((item, index) => (
            <QueueRow
              key={item.id}
              t={t}
              item={item}
              position={index + 1}
              isFirst={index === 0}
              isLast={index === queue.length - 1}
              // Whole sentences: Turkish conjugates the verb for "you".
              addedBy={
                item.addedBy === me
                  ? t('watchParty.queue.addedByYou')
                  : t('watchParty.queue.addedBy', { name: nameOf(item.addedBy) })
              }
              canManage={isHost}
              canRemove={isHost || item.addedBy === me}
              send={send}
            />
          ))}
        </ol>
      )}

      {state.current ? <AddLinkForm t={t} state={state} me={me} isHost={isHost} send={send} /> : null}
    </Panel>
  );
}

function QueueRow({
  t,
  item,
  position,
  isFirst,
  isLast,
  addedBy,
  canManage,
  canRemove,
  send,
}: {
  t: Translate;
  item: WatchPartyItem;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  /** "added by Kaya" / "added by you". */
  addedBy: string;
  canManage: boolean;
  canRemove: boolean;
  send: (action: WatchPartyClientAction) => void;
}) {
  const details = [addedBy];
  if (item.startSec > 0) details.push(t('watchParty.queue.startsAt', { time: formatTime(item.startSec) }));
  return (
    <li
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        borderRadius: 12,
        background: lf.raised,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 56,
          height: 32,
          flexShrink: 0,
          borderRadius: 6,
          background: lf.sunken,
          color: lf.muted,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlayIcon size={14} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 120px' }}>
        <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {youTubeShortLabel(item.videoId)}
        </span>
        <span style={{ fontSize: 12, color: lf.muted }}>{details.join(' · ')}</span>
      </div>
      <div style={{ display: 'flex', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
        <IconLink href={youTubeWatchUrl(item.videoId, item.startSec)} label={t('watchParty.queue.open', { n: position })}>
          <ExternalIcon />
        </IconLink>
        {canManage ? (
          <>
            <IconButton label={t('watchParty.queue.playNow', { n: position })} onClick={() => send({ type: 'queue-play', itemId: item.id })}>
              <PlayIcon size={16} />
            </IconButton>
            <IconButton
              label={t('watchParty.queue.moveUp', { n: position })}
              disabled={isFirst}
              onClick={() => send({ type: 'queue-move', itemId: item.id, toIndex: position - 2 })}
            >
              <UpIcon />
            </IconButton>
            <IconButton
              label={t('watchParty.queue.moveDown', { n: position })}
              disabled={isLast}
              onClick={() => send({ type: 'queue-move', itemId: item.id, toIndex: position })}
            >
              <DownIcon />
            </IconButton>
          </>
        ) : null}
        {canRemove ? (
          <IconButton label={t('watchParty.queue.remove', { n: position })} onClick={() => send({ type: 'queue-remove', itemId: item.id })}>
            <RemoveIcon />
          </IconButton>
        ) : null}
      </div>
    </li>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" aria-label={label} title={label} disabled={disabled} onClick={onClick} style={ICON_BUTTON}>
      {children}
    </Button>
  );
}

function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="lfui-btn lfui-btn-quiet"
      style={{
        ...ICON_BUTTON,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        color: lf.text2,
      }}
    >
      {children}
    </a>
  );
}
