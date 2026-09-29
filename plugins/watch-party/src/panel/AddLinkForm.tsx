/**
 * "Add a YouTube link". The link is checked here with the same parser the
 * reducer uses, so a bad link, a full queue or a duplicate is explained
 * before anything is sent — the reducer would silently ignore it, and an
 * action nobody sees fail is worse than none. The server still decides.
 *
 * The field is the kit's TextField: label, hint and error are wired to the
 * input for assistive tech. The hint is the spec's "suggest screen share"
 * for anything that is not on YouTube; the error is also a live region, so
 * it is announced when a submit is refused.
 */

import { useState } from 'react';
import { Button, Row, TextField } from '@lobbyforge/plugin-sdk/ui';
import { QUEUE_MAX, QUEUE_MAX_PER_USER } from '../constants';
import { queueRefusal, type WatchPartyClientAction } from '../reducer';
import type { WatchPartyState } from '../state';
import { parseYouTubeUrl } from '../youtube';
import type { Translate } from './types';

export function AddLinkForm({
  t,
  state,
  me,
  isHost,
  send,
}: {
  t: Translate;
  state: WatchPartyState;
  me: string;
  isHost: boolean;
  send: (action: WatchPartyClientAction) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hasVideo = state.current !== null;
  const empty = text.trim() === '';

  const submit = (mode: 'queue' | 'now') => {
    const url = text.trim();
    const link = parseYouTubeUrl(url);
    if (!link) {
      setError(t('watchParty.add.invalid'));
      return;
    }
    if (mode === 'now') {
      send({ type: 'set-video', url });
    } else {
      const refusal = queueRefusal(state, me, link);
      if (refusal !== null) {
        setError(
          refusal === 'full'
            ? t('watchParty.add.full', { max: QUEUE_MAX })
            : refusal === 'duplicate'
              ? t('watchParty.add.duplicate')
              : t('watchParty.add.perUser', { count: QUEUE_MAX_PER_USER })
        );
        return;
      }
      send({ type: 'queue-add', url });
    }
    setText('');
    setError(null);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit('queue');
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', textAlign: 'left' }}
    >
      <TextField
        label={t('watchParty.add.label')}
        hint={t('watchParty.add.screenShare')}
        error={error ? <span role="alert">{error}</span> : undefined}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={text}
        placeholder={t('watchParty.add.placeholder')}
        onChange={(event) => {
          setText(event.target.value);
          if (error) setError(null);
        }}
      />
      <Row gap={8} wrap>
        {!hasVideo ? (
          <Button type="submit" variant="primary" size="sm" disabled={empty}>
            {t('watchParty.add.load')}
          </Button>
        ) : isHost ? (
          <>
            <Button type="button" variant="primary" size="sm" disabled={empty} onClick={() => submit('now')}>
              {t('watchParty.add.playNow')}
            </Button>
            <Button type="submit" variant="secondary" size="sm" disabled={empty}>
              {t('watchParty.add.queue')}
            </Button>
          </>
        ) : (
          <Button type="submit" variant="primary" size="sm" disabled={empty}>
            {t('watchParty.add.queue')}
          </Button>
        )}
      </Row>
    </form>
  );
}
