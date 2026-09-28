'use client';

import { useCallback, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { BotJson } from '@/lib/bots/admin';
import { CUSTOM_BOT_TYPE } from '@/lib/bots/catalog';
import { ModerationBotCard, WelcomeBotCard } from './BuiltInBots';
import { CustomBots } from './CustomBots';
import { Alert, Dialog, Section, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

export default function BotsClient({
  serverId,
  serverName,
  initialBots,
  channels,
  loadError,
  canMutate,
}: {
  serverId: string | null;
  serverName: string;
  initialBots: BotJson[];
  channels: Array<{ id: string; name: string }>;
  loadError: string | null;
  canMutate: boolean;
}) {
  const t = useT();
  const [bots, setBots] = useState(initialBots);
  const [reveal, setReveal] = useState<{ botName: string; token: string } | null>(null);

  const upsert = useCallback((bot: BotJson) => {
    setBots((current) =>
      current.some((b) => b.id === bot.id) ? current.map((b) => (b.id === bot.id ? bot : b)) : [...current, bot]
    );
  }, []);
  const remove = useCallback((botId: string) => {
    setBots((current) => current.filter((b) => b.id !== botId));
  }, []);

  const welcome = bots.find((b) => b.type === 'welcome') ?? null;
  const moderation = bots.find((b) => b.type === 'moderation') ?? null;
  const custom = bots.filter((b) => b.type === CUSTOM_BOT_TYPE);

  return (
    <section className="mx-auto max-w-5xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('bots.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('bots.subtitle')}</p>
      </header>

      {loadError ? <Alert tone="danger">{t('bots.loadError', { error: loadError })}</Alert> : null}
      {!serverId ? <Alert tone="danger">{t('adminSettings.common.noServer')}</Alert> : null}

      <Section title={t('bots.builtin.title')} icon="smart_toy" intro={t('bots.builtin.intro')}>
        <div className="grid gap-4">
          <WelcomeBotCard
            bot={welcome}
            serverId={serverId}
            serverName={serverName}
            channels={channels}
            canMutate={canMutate}
            onSaved={upsert}
          />
          <ModerationBotCard
            bot={moderation}
            serverId={serverId}
            canMutate={canMutate}
            onSaved={upsert}
          />
        </div>
      </Section>

      <Section title={t('bots.custom.title')} icon="api" intro={t('bots.custom.intro')}>
        <CustomBots
          bots={custom}
          serverId={serverId}
          canMutate={canMutate}
          onChange={upsert}
          onRemoved={remove}
          onToken={setReveal}
        />
      </Section>

      {reveal ? <TokenDialog botName={reveal.botName} token={reveal.token} onClose={() => setReveal(null)} /> : null}
    </section>
  );
}

/** The token, once. Closing the dialog is the last time anyone sees it. */
function TokenDialog({ botName, token, onClose }: { botName: string; token: string; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      title={t('bots.token.title', { name: botName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={() => void copy()} className={secondaryButtonClass}>
            {copied ? t('bots.token.copied') : t('bots.token.copy')}
          </button>
          <button type="button" onClick={onClose} className={primaryButtonClass}>
            {t('bots.token.done')}
          </button>
        </>
      }
    >
      <p>{t('bots.token.body')}</p>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs font-medium text-text-secondary">{t('bots.token.label')}</span>
        <input
          readOnly
          data-autofocus
          data-testid="bot-token"
          value={token}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} font-mono text-xs`}
        />
      </label>
      <p className="mt-3 text-xs text-danger">{t('bots.token.warning')}</p>
    </Dialog>
  );
}
