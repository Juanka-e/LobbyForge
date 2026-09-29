import type { ReactNode } from 'react';
import { hubDisplayFont } from '@/app/(marketing)/_components/fonts';
import { HubLogo } from '@/app/(marketing)/_components/HubLogo';

/**
 * The official hub's split sign-in layout: a panel about the account on
 * the left, the form on the right. Below `lg` the panel is left out and
 * the logo sits above the form.
 *
 * The panel's big headline is a paragraph, not a heading: it is there to
 * persuade, and the form's own title stays the page's one `<h1>`.
 */
export default function OfficialAuthLayout({
  panel,
  footnote,
  children,
}: {
  panel: ReactNode;
  footnote: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${hubDisplayFont.variable} grid min-h-dvh lg:grid-cols-[minmax(460px,600px)_minmax(0,1fr)]`}>
      <div className="hidden flex-col justify-between gap-12 border-r border-border-subtle/60 bg-background px-12 py-12 lg:flex xl:px-16">
        <HubLogo href="/landing" />
        <div className="flex flex-col gap-[22px]">{panel}</div>
        <div className="text-[13px] text-text-muted">{footnote}</div>
      </div>
      <div className="flex flex-col px-5 pb-12 pt-8 sm:px-8 lg:items-center lg:justify-center lg:py-12">
        <div className="mb-10 lg:hidden">
          <HubLogo href="/landing" />
        </div>
        <div className="mx-auto w-full max-w-[420px]">{children}</div>
      </div>
    </div>
  );
}
