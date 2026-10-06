/**
 * The mail provider registry (docs/EMAIL.md §2.2): pure data, no secrets,
 * importable from client code. The admin screen renders its provider
 * picker from this list; choosing a preset fills host, port and security
 * and shows the hints (message keys in `messages/<locale>/mailProviders.json`).
 *
 * Adding a provider = appending one entry here plus its message keys (and
 * its id to MAIL_PROVIDER_IDS). No migration: `mail_provider` is a slug.
 *
 * Every host, port and username convention below was checked against the
 * provider's own documentation on 2026-10-04 (the URLs are in each entry).
 * Ports are listed recommended-first and only where §3.4 allows them
 * (25, 465, 587, 2465, 2525, 2587): providers' extra ports such as 80, 443,
 * 588, 8025 or 8465 are left out on purpose.
 */
import type { MailProviderId, SmtpSecurity } from './types';

export interface MailProviderPreset {
  id: MailProviderId;
  /** Brand name, shown as is (product names are not translated). */
  name: string;
  tier: 'professional' | 'free' | 'custom' | 'development';
  transport: 'smtp';
  /** Region → host (SES regions, Mailgun US/EU, SMTP2GO data centres). The first is the default. */
  regions?: { id: string; host: string }[];
  /** Fixed host when there are no regions. */
  host?: string;
  /** First = recommended. `none` only for the development preset. */
  ports: { port: number; security: SmtpSecurity }[];
  /** Message key (mailProviders.json). */
  usernameHint: string;
  /** Message key (mailProviders.json). */
  passwordHint: string;
  freeTier?: { perDay?: number; perMonth?: number; noteKey?: string };
  pricingNoteKey?: string;
  /** The provider's SMTP setup page. */
  docsUrl: string;
  /** EU option / where the data lives (message key). */
  dataRegionNoteKey?: string;
  /**
   * A hosted relay outside Türkiye: addresses leave the country, so the
   * admin screen shows the KVKK note (the privacy notice should name the
   * provider). False for custom servers and mailpit.
   */
  crossBorder: boolean;
}

const STARTTLS = 'starttls' as const;
const TLS = 'tls' as const;

export const MAIL_PROVIDERS: readonly MailProviderPreset[] = [
  {
    // https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html (ports, STARTTLS vs TLS wrapper)
    // https://docs.aws.amazon.com/general/latest/gr/ses.html (regions with an SMTP endpoint;
    //   eu-south-1 and eu-central-2 have none)
    // https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html (SMTP credentials ≠ access keys; per region)
    id: 'ses',
    name: 'Amazon SES',
    tier: 'professional',
    transport: 'smtp',
    regions: [
      'eu-central-1',
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
      'eu-north-1',
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
    ].map((id) => ({ id, host: `email-smtp.${id}.amazonaws.com` })),
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2587, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 2465, security: TLS },
    ],
    usernameHint: 'mailProviders.ses.usernameHint',
    passwordHint: 'mailProviders.ses.passwordHint',
    pricingNoteKey: 'mailProviders.ses.pricingNote',
    docsUrl: 'https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html',
    dataRegionNoteKey: 'mailProviders.ses.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/
    //   (smtp.tem.scaleway.com; 587/2587 STARTTLS, 465/2465 TLS, 25 "not recommended";
    //   username = project ID, password = IAM API secret key)
    // https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/
    id: 'scaleway',
    name: 'Scaleway Transactional Email',
    tier: 'professional',
    transport: 'smtp',
    host: 'smtp.tem.scaleway.com',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2587, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 2465, security: TLS },
    ],
    usernameHint: 'mailProviders.scaleway.usernameHint',
    passwordHint: 'mailProviders.scaleway.passwordHint',
    freeTier: { perMonth: 300 },
    pricingNoteKey: 'mailProviders.scaleway.pricingNote',
    docsUrl: 'https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/',
    dataRegionNoteKey: 'mailProviders.scaleway.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://developers.brevo.com/docs/smtp-integration (smtp-relay.brevo.com; 587, 2525, 465;
    //   SMTP key, not the v3 API key)
    id: 'brevo',
    name: 'Brevo',
    tier: 'free',
    transport: 'smtp',
    host: 'smtp-relay.brevo.com',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2525, security: STARTTLS },
      { port: 465, security: TLS },
    ],
    usernameHint: 'mailProviders.brevo.usernameHint',
    passwordHint: 'mailProviders.brevo.passwordHint',
    freeTier: { perDay: 300, noteKey: 'mailProviders.brevo.freeTierNote' },
    docsUrl: 'https://developers.brevo.com/docs/smtp-integration',
    dataRegionNoteKey: 'mailProviders.brevo.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://developers.smtp2go.com/docs/smtp-relay (2525 recommended, 25/587 STARTTLS, 465 SSL;
    //   mail.smtp2go.com, mail-eu / mail-us / mail-au regional hosts; SMTP users under Sending → SMTP Users)
    // https://www.smtp2go.com/faq/ (free plan: 1,000/month, 200/day)
    id: 'smtp2go',
    name: 'SMTP2GO',
    tier: 'free',
    transport: 'smtp',
    regions: [
      { id: 'global', host: 'mail.smtp2go.com' },
      { id: 'eu', host: 'mail-eu.smtp2go.com' },
      { id: 'us', host: 'mail-us.smtp2go.com' },
      { id: 'au', host: 'mail-au.smtp2go.com' },
    ],
    ports: [
      { port: 2525, security: STARTTLS },
      { port: 587, security: STARTTLS },
      { port: 25, security: STARTTLS },
      { port: 465, security: TLS },
    ],
    usernameHint: 'mailProviders.smtp2go.usernameHint',
    passwordHint: 'mailProviders.smtp2go.passwordHint',
    freeTier: { perDay: 200, perMonth: 1000, noteKey: 'mailProviders.smtp2go.freeTierNote' },
    docsUrl: 'https://developers.smtp2go.com/docs/smtp-relay',
    dataRegionNoteKey: 'mailProviders.smtp2go.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://resend.com/docs/send-with-smtp (smtp.resend.com; 465/2465 SMTPS, 25/587/2587 STARTTLS;
    //   username "resend", password = API key)
    // https://resend.com/pricing (3,000/month, 100/day)
    // https://resend.com/docs/dashboard/domains/regions
    id: 'resend',
    name: 'Resend',
    tier: 'free',
    transport: 'smtp',
    host: 'smtp.resend.com',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2587, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 2465, security: TLS },
      { port: 25, security: STARTTLS },
    ],
    usernameHint: 'mailProviders.resend.usernameHint',
    passwordHint: 'mailProviders.resend.passwordHint',
    freeTier: { perDay: 100, perMonth: 3000 },
    docsUrl: 'https://resend.com/docs/send-with-smtp',
    dataRegionNoteKey: 'mailProviders.resend.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://dev.mailjet.com/smtp-relay/configuration/ (in-v3.mailjet.com; STARTTLS 25/587/2525,
    //   SSL 465; username = API key, password = secret key)
    // https://www.mailjet.com/pricing/ (6,000/month, 200/day, logo on free emails)
    id: 'mailjet',
    name: 'Mailjet',
    tier: 'free',
    transport: 'smtp',
    host: 'in-v3.mailjet.com',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2525, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 25, security: STARTTLS },
    ],
    usernameHint: 'mailProviders.mailjet.usernameHint',
    passwordHint: 'mailProviders.mailjet.passwordHint',
    freeTier: { perDay: 200, perMonth: 6000, noteKey: 'mailProviders.mailjet.freeTierNote' },
    docsUrl: 'https://dev.mailjet.com/smtp-relay/configuration/',
    dataRegionNoteKey: 'mailProviders.mailjet.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp
    //   (587 recommended, 25/2525 STARTTLS, 465 TLS; per-domain SMTP credentials)
    // https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview (smtp.eu.mailgun.org)
    // https://www.mailgun.com/pricing/ (100/day free)
    id: 'mailgun',
    name: 'Mailgun',
    tier: 'free',
    transport: 'smtp',
    regions: [
      { id: 'us', host: 'smtp.mailgun.org' },
      { id: 'eu', host: 'smtp.eu.mailgun.org' },
    ],
    ports: [
      { port: 587, security: STARTTLS },
      { port: 2525, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 25, security: STARTTLS },
    ],
    usernameHint: 'mailProviders.mailgun.usernameHint',
    passwordHint: 'mailProviders.mailgun.passwordHint',
    freeTier: { perDay: 100, noteKey: 'mailProviders.mailgun.freeTierNote' },
    docsUrl: 'https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp',
    dataRegionNoteKey: 'mailProviders.mailgun.dataRegionNote',
    crossBorder: true,
  },
  {
    // https://developers.google.com/workspace/gmail/imap/imap-smtp (smtp.gmail.com, 465 SSL / 587 STARTTLS)
    // https://support.google.com/accounts/answer/185833 (app passwords need 2-Step Verification)
    // https://support.google.com/mail/answer/22839 (500 a day)
    id: 'gmail',
    name: 'Gmail',
    tier: 'free',
    transport: 'smtp',
    host: 'smtp.gmail.com',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 465, security: TLS },
    ],
    usernameHint: 'mailProviders.gmail.usernameHint',
    passwordHint: 'mailProviders.gmail.passwordHint',
    freeTier: { perDay: 500, noteKey: 'mailProviders.gmail.freeTierNote' },
    docsUrl: 'https://support.google.com/mail/answer/7104828',
    crossBorder: true,
  },
  {
    id: 'custom',
    name: 'Custom SMTP',
    tier: 'custom',
    transport: 'smtp',
    ports: [
      { port: 587, security: STARTTLS },
      { port: 465, security: TLS },
      { port: 2525, security: STARTTLS },
      { port: 2587, security: STARTTLS },
      { port: 2465, security: TLS },
      { port: 25, security: STARTTLS },
    ],
    usernameHint: 'mailProviders.custom.usernameHint',
    passwordHint: 'mailProviders.custom.passwordHint',
    docsUrl: 'https://github.com/Juanka-e/LobbyForge/blob/main/docs/EMAIL.md',
    crossBorder: false,
  },
  {
    // infra/docker/docker-compose.dev.yml (`full` profile): SMTP on host port 19525, web UI 19526;
    // inside compose the service is `mailpit:1025`. This entry is the dev-host variant
    // (`next dev` on the host reaches localhost:19525); in production the
    // registry hands out `MAILPIT_COMPOSE_PRESET` instead (see `getMailProvider`).
    id: 'mailpit',
    name: 'Mailpit',
    tier: 'development',
    transport: 'smtp',
    host: 'localhost',
    ports: [
      { port: 19525, security: 'none' },
      { port: 1025, security: 'none' },
    ],
    usernameHint: 'mailProviders.mailpit.usernameHint',
    passwordHint: 'mailProviders.mailpit.passwordHint',
    docsUrl: 'https://mailpit.axllent.org/docs/',
    dataRegionNoteKey: 'mailProviders.mailpit.dataRegionNote',
    crossBorder: false,
  },
];

/**
 * The development preset as a production build runs it: inside Docker
 * Compose, where the app reaches the `mailpit` service on its own port 1025
 * (`localhost` there is the app container itself, and production refuses
 * loopback anyway — docs/EMAIL.md §3.4).
 */
const MAILPIT_DEV_PRESET = MAIL_PROVIDERS.find((preset) => preset.id === 'mailpit')!;
export const MAILPIT_COMPOSE_PRESET: MailProviderPreset = Object.freeze({
  ...MAILPIT_DEV_PRESET,
  host: 'mailpit',
  ports: [{ port: 1025, security: 'none' as const }],
});

function isProductionBuild(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * A preset by id. The development preset depends on where the app runs:
 * `localhost:19525` outside production (the dev host), `mailpit:1025` in a
 * production build (inside compose).
 */
export function getMailProvider(id: string | null | undefined, context: { production?: boolean } = {}): MailProviderPreset | null {
  if (!id) return null;
  if (id === 'mailpit' && (context.production ?? isProductionBuild())) return MAILPIT_COMPOSE_PRESET;
  return MAIL_PROVIDERS.find((preset) => preset.id === id) ?? null;
}

/** The host a preset implies: its fixed host, or the chosen (else first) region's host. */
export function presetHost(preset: MailProviderPreset, region?: string | null): string | null {
  if (preset.host) return preset.host;
  if (!preset.regions?.length) return null;
  return (region ? preset.regions.find((r) => r.id === region) : undefined)?.host ?? preset.regions[0]!.host;
}

/** The region of a host within a preset (env-configured SES host → its region), or null. */
export function presetRegionForHost(preset: MailProviderPreset, host: string | null | undefined): string | null {
  if (!host || !preset.regions) return null;
  return preset.regions.find((region) => region.host === host.toLowerCase())?.id ?? null;
}

/**
 * Is the development preset offered here (§2.2)? On every instance that is
 * not the official hub — labelled Development (its tier) — and never on the
 * hub. In production it is the compose variant (`mailpit:1025`), which the
 * host rules accept only there (§3.4), so what is offered is exactly what a
 * save accepts.
 */
export function mailpitOffered(input: { official: boolean }): boolean {
  return !input.official;
}

/**
 * The registry as the admin screen should see it here: the development
 * preset left out on the official hub, and in its production (compose)
 * variant in a production build.
 */
export function offeredMailProviders(input: { production: boolean; official: boolean }): MailProviderPreset[] {
  return MAIL_PROVIDERS.filter((preset) => preset.tier !== 'development' || mailpitOffered(input)).map((preset) =>
    preset.id === 'mailpit' && input.production ? MAILPIT_COMPOSE_PRESET : preset
  );
}

/** Every message key the registry uses (the integrity test checks they exist in every complete language). */
export function mailProviderMessageKeys(): string[] {
  const keys = new Set<string>();
  for (const preset of MAIL_PROVIDERS) {
    keys.add(preset.usernameHint);
    keys.add(preset.passwordHint);
    if (preset.freeTier?.noteKey) keys.add(preset.freeTier.noteKey);
    if (preset.pricingNoteKey) keys.add(preset.pricingNoteKey);
    if (preset.dataRegionNoteKey) keys.add(preset.dataRegionNoteKey);
  }
  return [...keys];
}
