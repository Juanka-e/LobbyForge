'use client';

import { Modal, ModalCancelButton, ModalPrimaryButton } from '@/components/Modal';
import { useT } from '@/lib/i18n/client';
import type { PluginApprovals } from '@/lib/plugin-approvals';
import { SANDBOX_NETWORK_KINDS, type SandboxPermission } from '@/lib/sandbox-manifest';

/** The install route's 409 `approval_required` body (plugin-install-layout.ts `ApprovalRequired`). */
export interface ApprovalRequest {
  requested: PluginApprovals;
  /** What the active version had not approved; null on a first install. */
  added: PluginApprovals | null;
  previous: PluginApprovals | null;
}

/** The host part of an origin or URL, which is what the owner recognises. */
function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

const PERMISSION_KEYS: Record<SandboxPermission, string> = {
  timers: 'hub.marketplace.approval.permission.timers',
  storage: 'hub.marketplace.approval.permission.storage',
  chat: 'hub.marketplace.approval.permission.chat',
  'voice.mute': 'hub.marketplace.approval.permission.voiceMute',
};

/**
 * What a marketplace plugin asks for beyond the sandbox, for the instance
 * owner to approve before it is installed (docs/PLUGIN_UNLOCK_PLAN.md).
 * Each item says what it lets the plugin do in plain words; on an upgrade
 * the items the active version had not approved are marked new.
 */
export function PluginApprovalDialog({
  pluginName,
  request,
  busy,
  onApprove,
  onCancel,
}: {
  pluginName: string;
  request: ApprovalRequest | null;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const requested = request?.requested ?? {};
  const upgrade = Boolean(request?.previous);
  const isNew = (check: (added: PluginApprovals) => boolean) => upgrade && request?.added != null && check(request.added);
  const newBadge = (
    <span className="ms-2 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
      {t('hub.marketplace.approval.new')}
    </span>
  );

  return (
    <Modal
      open={request !== null}
      onClose={onCancel}
      title={t('hub.marketplace.approval.title', { name: pluginName })}
      description={t(upgrade ? 'hub.marketplace.approval.descriptionUpgrade' : 'hub.marketplace.approval.description')}
      size="lg"
      disableBackdropClose
      footer={
        <>
          <ModalCancelButton onClick={onCancel} disabled={busy} />
          <ModalPrimaryButton onClick={onApprove} loading={busy}>
            {t('hub.marketplace.approval.approve')}
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="space-y-5 pb-2 text-sm" data-plugin-approval>
        {requested.uiUrl ? (
          <section>
            <h3 className="font-semibold text-text-primary">
              {t('hub.marketplace.approval.uiTitle')}
              {isNew((added) => Boolean(added.uiUrl)) ? newBadge : null}
            </h3>
            <p className="mt-1 font-mono text-text-primary">{hostOf(requested.uiUrl)}</p>
            <p className="mt-1 text-text-secondary">{t('hub.marketplace.approval.uiBody')}</p>
          </section>
        ) : null}

        {requested.network ? (
          <section>
            <h3 className="font-semibold text-text-primary">{t('hub.marketplace.approval.networkTitle')}</h3>
            <p className="mt-1 text-text-secondary">{t('hub.marketplace.approval.networkBody')}</p>
            <dl className="mt-2 space-y-2">
              {SANDBOX_NETWORK_KINDS.map((kind) => {
                const origins = requested.network?.[kind];
                if (!origins?.length) return null;
                return (
                  <div key={kind}>
                    <dt className="text-xs font-medium text-text-muted">{t(`hub.marketplace.approval.network.${kind}`)}</dt>
                    <dd>
                      <ul className="mt-0.5 space-y-0.5">
                        {origins.map((origin) => (
                          <li key={origin} className="font-mono text-text-primary">
                            {hostOf(origin)}
                            {isNew((added) => Boolean(added.network?.[kind]?.includes(origin))) ? newBadge : null}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ) : null}

        {requested.permissions?.length ? (
          <section>
            <h3 className="font-semibold text-text-primary">{t('hub.marketplace.approval.permissionsTitle')}</h3>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-text-primary">
              {requested.permissions.map((name) => (
                <li key={name}>
                  {t(PERMISSION_KEYS[name])}
                  {isNew((added) => Boolean(added.permissions?.includes(name))) ? newBadge : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="text-xs text-text-muted">{t('hub.marketplace.approval.footnote')}</p>
      </div>
    </Modal>
  );
}
