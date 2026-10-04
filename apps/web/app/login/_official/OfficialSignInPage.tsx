import { CheckIcon } from '@/app/(marketing)/_components/icons';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { rich } from '@/lib/i18n/rich';
import { getTranslator } from '@/lib/i18n/server';
import { isGoogleOAuthConfigured } from '@/lib/oauth-google';
import { loginErrorKey } from '../login-errors';
import OfficialAuthLayout from './OfficialAuthLayout';
import OfficialSignInForm from './OfficialSignInForm';
import { authLink } from './styles';

/** `/login` on the official hub (see ../page.tsx for the self-hosted one). */
export default async function OfficialSignInPage({
  errorCode,
  desktopLoginState,
  nextPath,
}: {
  errorCode?: string;
  desktopLoginState?: string;
  /** `?next=`, already checked: where to go once signed in (else the hub home). */
  nextPath?: string;
}) {
  const t = await getTranslator();
  const errorKey = loginErrorKey(errorCode);
  const perks = [
    t('auth.official.signIn.perks.communities'),
    t('auth.official.signIn.perks.desktop'),
    t('auth.official.signIn.perks.publish'),
  ];
  return (
    <OfficialAuthLayout
      panel={
        <>
          <p className="text-balance font-display text-[44px] font-extrabold leading-[1.04] tracking-[-0.03em] text-text-primary xl:text-[54px]">
            {t('auth.official.signIn.headline')}
          </p>
          <p className="max-w-[420px] text-pretty text-[17px] leading-[1.6] text-text-secondary">
            {t('auth.official.signIn.intro')}
          </p>
          <ul className="flex flex-col gap-3">
            {perks.map((perk) => (
              <li key={perk} className="flex items-center gap-3 text-[15px] text-text-primary">
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <CheckIcon size={14} />
                </span>
                {perk}
              </li>
            ))}
          </ul>
        </>
      }
      footnote={rich(t('auth.official.signIn.footnote', { license: LOBBYFORGE_REPO.license }), {
        repo: (
          <a href={LOBBYFORGE_REPO.url} className={authLink}>
            {LOBBYFORGE_REPO.url.replace(/^https:\/\//, '')}
          </a>
        ),
      })}
    >
      <OfficialSignInForm
        googleEnabled={isGoogleOAuthConfigured()}
        desktopLoginState={desktopLoginState}
        initialError={errorKey ? t(errorKey) : null}
        nextPath={nextPath}
      />
    </OfficialAuthLayout>
  );
}
