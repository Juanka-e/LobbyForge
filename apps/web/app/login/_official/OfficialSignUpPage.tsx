import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { getTranslator } from '@/lib/i18n/server';
import OfficialAuthLayout from './OfficialAuthLayout';
import OfficialSignUpForm from './OfficialSignUpForm';

/** `/register` on the official hub (a self-hosted instance deep-links to its sign-in's tab). */
export default async function OfficialSignUpPage() {
  const t = await getTranslator();
  const steps = [
    t('auth.official.signUp.steps.find'),
    t('auth.official.signUp.steps.desktop'),
    t('auth.official.signUp.steps.host'),
  ];
  return (
    <OfficialAuthLayout
      panel={
        <>
          <p className="text-balance font-display text-[44px] font-extrabold leading-[1.04] tracking-[-0.03em] text-text-primary xl:text-[54px]">
            {t('auth.official.signUp.headline')}
          </p>
          <p className="max-w-[430px] text-pretty text-[17px] leading-[1.6] text-text-secondary">
            {t('auth.official.signUp.intro')}
          </p>
          <div className="flex max-w-[440px] flex-col gap-3.5 rounded-[20px] border border-border-subtle/70 bg-surface p-5">
            <p className="text-xs uppercase tracking-[0.14em] text-text-muted">{t('auth.official.signUp.stepsTitle')}</p>
            <ol className="flex flex-col gap-3.5">
              {steps.map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-surface-raised text-[13px] font-semibold text-ember"
                  >
                    {index + 1}
                  </span>
                  <span className="text-[15px] leading-[1.5] text-text-primary">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </>
      }
      footnote={t('auth.official.signUp.footnote', { license: LOBBYFORGE_REPO.license })}
    >
      <OfficialSignUpForm />
    </OfficialAuthLayout>
  );
}
