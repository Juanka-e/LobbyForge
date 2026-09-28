/**
 * The 16:9 stage: YouTube's privacy-enhanced player, and what is laid
 * over it when the viewer has to do something (join playback, press
 * play on the video) or cannot watch (an error).
 *
 * THE IFRAME is the whole integration surface:
 *  - `src` is always youtube-nocookie.com — the one origin the app's CSP
 *    frames — and is rebuilt only from a validated 11-character id.
 *  - `sandbox` is the set YouTube's own iframe_api applies, minus
 *    `allow-top-navigation`: the player may run, open its links in a new
 *    tab and present fullscreen, but never navigate the lobby away.
 *  - `allow` delegates autoplay (so a click in the lobby lets the video
 *    start with sound), fullscreen, picture-in-picture, DRM playback and
 *    the player's own copy/share buttons — nothing else (no camera, mic
 *    or sensors).
 *  - `key={item.id}`: a new video is a new player.
 */

import type { CSSProperties, RefObject } from 'react';
import { Button, lf } from '@lobbyforge/plugin-sdk/ui';
import type { SyncView } from '../controller';
import { playerErrorKind } from '../player-protocol';
import type { WatchPartyItem } from '../state';
import { youTubeEmbedUrl, youTubeWatchUrl } from '../youtube';
import { PlayIcon } from './icons';
import type { Translate } from './types';

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms';
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write; web-share';

/** Overlays sit on the video, so they are dark in every theme and carry their own light text. */
const SCRIM: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 24,
  textAlign: 'center',
  background: 'rgba(5, 7, 11, 0.78)',
  color: '#F4F7FB',
};

const BANNER: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  right: 12,
  padding: '10px 14px',
  borderRadius: 14,
  background: 'rgba(5, 7, 11, 0.86)',
  color: '#F4F7FB',
  fontSize: 14,
  lineHeight: 1.45,
  // Clicks go through to the player underneath: pressing play on the
  // video is exactly what this banner asks for.
  pointerEvents: 'none',
};

export function PlayerStage({
  t,
  item,
  origin,
  frameRef,
  view,
  isHost,
  onJoin,
}: {
  t: Translate;
  item: WatchPartyItem;
  /** The page's origin, once known (the player is told where to talk back to). */
  origin: string | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  view: SyncView;
  isHost: boolean;
  onJoin: () => void;
}) {
  const errorKind = view.error === null ? null : playerErrorKind(view.error);
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 9',
        borderRadius: 22,
        overflow: 'hidden',
        // A video well is black in every theme — the player inside is, and
        // a light flash before it loads would be worse than consistent.
        background: '#05070B',
        border: `1px solid ${lf.border}`,
      }}
    >
      {origin ? (
        <iframe
          key={item.id}
          ref={frameRef}
          src={youTubeEmbedUrl(item.videoId, origin)}
          title={view.title ? t('watchParty.stage.frameTitleWithVideo', { title: view.title }) : t('watchParty.stage.frameTitle')}
          allow={ALLOW}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox={SANDBOX}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      ) : null}

      {errorKind ? (
        <div style={SCRIM} role="alert">
          <strong style={{ fontSize: 16 }}>
            {errorKind === 'notEmbeddable'
              ? t('watchParty.error.notEmbeddable')
              : errorKind === 'notFound'
                ? t('watchParty.error.notFound')
                : errorKind === 'badLink'
                  ? t('watchParty.error.badLink')
                  : t('watchParty.error.failed')}
          </strong>
          <span style={{ fontSize: 14, opacity: 0.85 }}>
            {isHost ? t('watchParty.error.hostHint') : t('watchParty.error.viewerHint')}
          </span>
          <a
            href={youTubeWatchUrl(item.videoId, item.startSec)}
            target="_blank"
            rel="noopener noreferrer"
            className="lfui-focus"
            style={{ color: '#C9DAFF', fontSize: 14, fontWeight: 600 }}
          >
            {t('watchParty.error.openOnYouTube')}
          </a>
        </div>
      ) : !view.engaged ? (
        <div style={SCRIM}>
          <strong style={{ fontSize: 17 }}>{t('watchParty.stage.joinTitle')}</strong>
          <span style={{ fontSize: 14, maxWidth: 380, opacity: 0.85 }}>{t('watchParty.stage.joinBody')}</span>
          <Button variant="success" size="lg" onClick={onJoin}>
            <PlayIcon size={18} />
            {t('watchParty.stage.joinButton')}
          </Button>
        </div>
      ) : view.blocked ? (
        <div style={BANNER} role="status">
          {t('watchParty.stage.blocked')}
        </div>
      ) : view.stalled ? (
        <div style={BANNER} role="status">
          {t('watchParty.stage.stalled')}
        </div>
      ) : null}
    </div>
  );
}
