---
name: LobbyForge Calm Future Design System
version: '2.0'
product: LobbyForge
language: English-first, global
intent: Premium open-source landing and app UI for a self-hosted voice community platform
colors:
  surface: '#111722'
  surface-dim: '#101419'
  surface-bright: '#36393f'
  surface-container-lowest: '#0b0e13'
  surface-container-low: '#181c21'
  surface-container: '#1d2025'
  surface-container-high: '#272a30'
  surface-container-highest: '#32353b'
  on-surface: '#e0e2ea'
  on-surface-variant: '#c3c6d2'
  inverse-surface: '#e0e2ea'
  inverse-on-surface: '#2d3036'
  outline: '#8d919b'
  outline-variant: '#434750'
  surface-tint: '#a9c7ff'
  primary: '#bdd3ff'
  on-primary: '#003063'
  primary-container: '#8fb8ff'
  on-primary-container: '#144787'
  inverse-primary: '#325e9f'
  secondary: '#bcc7da'
  on-secondary: '#26313f'
  secondary-container: '#3d4757'
  on-secondary-container: '#abb6c8'
  tertiary: '#fccb7b'
  on-tertiary: '#432c00'
  tertiary-container: '#deb063'
  on-tertiary-container: '#614200'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d6e3ff'
  primary-fixed-dim: '#a9c7ff'
  on-primary-fixed: '#001b3d'
  on-primary-fixed-variant: '#124686'
  secondary-fixed: '#d8e3f6'
  secondary-fixed-dim: '#bcc7da'
  on-secondary-fixed: '#111c2a'
  on-secondary-fixed-variant: '#3d4757'
  tertiary-fixed: '#ffdeac'
  tertiary-fixed-dim: '#efbf70'
  on-tertiary-fixed: '#281900'
  on-tertiary-fixed-variant: '#5f4100'
  background: '#101419'
  on-background: '#e0e2ea'
  surface-variant: '#32353b'
  bg-soft: '#0B1018'
  surface-raised: '#171E2B'
  surface-floating: '#1D2533'
  border-subtle: '#263142'
  border-strong: '#334155'
  text-primary: '#F4F7FB'
  text-secondary: '#B7C0CC'
  text-muted: '#7F8A99'
  success: '#7CCFA6'
  danger: '#E98282'
typography:
  hero-h1:
    fontFamily: Geist
    fontSize: 80px
    fontWeight: '600'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  hero-h1-mobile:
    fontFamily: Geist
    fontSize: 40px
    fontWeight: '600'
    lineHeight: '1.2'
  section-h2:
    fontFamily: Geist
    fontSize: 52px
    fontWeight: '600'
    lineHeight: '1.2'
  section-h2-mobile:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.05em
  label-xs:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  container-max: 1240px
  gutter: 24px
  margin-desktop: 64px
  margin-mobile: 24px
  section-gap: 120px
---

# LobbyForge Design System

## Product feeling

LobbyForge should feel like a calm, premium, future-facing open-source product. It is not a neon gaming product, not a crypto dashboard, not an AI landing page, and not a Discord clone. It should feel familiar to people who understand servers, channels, voice rooms, chat, roles, bots, and communities, but it should add a clearer layer of ownership, self-hosting, games, apps, and public discovery.

The emotional direction is: quiet power, ownership, clarity, trust, modern community infrastructure.

## Visual principles

1. Calm before flashy.
2. Premium before colorful.
3. Product clarity before decoration.
4. Familiar voice-community structure, but refined.
5. Future-facing through layout, spacing, typography, glassy depth, and precise UI details; not through loud neon colors.

## Color palette

Use restrained, eye-comfortable colors. No bright green, no toxic mint, no saturated purple gradients, no childish gamer palette.

### Core colors

- Background / Space: `#070A0F`
- Background soft: `#0B1018`
- Surface: `#111722`
- Surface raised: `#171E2B`
- Surface floating: `#1D2533`
- Border subtle: `#263142`
- Border strong: `#334155`

### Text colors

- Text primary: `#F4F7FB`
- Text secondary: `#B7C0CC`
- Text muted: `#7F8A99`
- Text disabled: `#596575`

### Brand and state colors

- Primary accent / Ice blue: `#8FB8FF`
- Primary hover: `#A9C8FF`
- Primary soft background: `rgba(143, 184, 255, 0.12)`
- Secondary accent / Soft steel: `#A8B3C5`
- Game/activity accent / Soft amber: `#E7B86A`
- Success: `#7CCFA6`
- Warning: `#E7B86A`
- Danger: `#E98282`

Use ice blue sparingly for primary actions, focus states, selected navigation, and important highlights. Use amber only for games, activities, special room states, or playful interactive elements. The page should not look blue-heavy; the blue should guide the eye.

## Gradients and lighting

Use very subtle gradients only:
- Background gradient: `radial-gradient(circle at 50% 0%, rgba(143,184,255,0.10), transparent 34%), linear-gradient(180deg, #070A0F 0%, #0B1018 55%, #070A0F 100%)`
- Card glow: very soft blue shadow, low opacity.
- Avoid glowing orbs, aggressive bloom, cyberpunk effects, and colorful abstract backgrounds.

## Typography

Use a modern sans-serif. The typography should feel global, precise, and technical but not cold.

Recommended type direction:
- Headings: Inter, Geist, Satoshi, or similar modern sans.
- Body: Inter, Geist, or system sans.

Hero headings should be large, confident, and clean. Avoid overly condensed gamer fonts and decorative serif fonts.

### Type scale

- Hero H1: 64–80px desktop, 42–52px tablet, 34–40px mobile.
- Section H2: 40–52px desktop, 30–38px mobile.
- Body: 16–18px.
- Small labels: 12–14px, uppercase only when useful.

Line height should be comfortable. Do not cram text.

## Layout

Use spacious premium landing layout:
- Max content width: 1180–1240px.
- Large vertical breathing room.
- Short page, not an endless dashboard.
- First viewport must feel like a real landing page, not an app screen pasted on a black background.
- Use product screenshots/mockups as visuals inside the landing page, not as the entire page.

Landing page should have only these sections:
1. Hero
2. Feature strip
3. Product preview
4. Self-host / open-source ownership
5. Final CTA

## Product mockup style

Product mockups should look like polished screenshot frames:
- Rounded outer frame: 24–32px radius.
- Thin border with low opacity.
- Soft inner highlight at top edge.
- Gentle shadow.
- UI inside should be readable but not over-detailed.
- Avoid tiny unreadable text.
- Avoid too many widgets in one mockup.

Inside product UI, show familiar structure:
- Server/channel sidebar
- Voice room
- Chat
- Participants
- Bots
- Start Activity button
- Games/apps hint
- Server health / Doctor badge

The UI should feel real, but simplified enough for landing.

## Components

### Buttons

Primary button:
- Background: `#8FB8FF`
- Text: `#07101E`
- Rounded: 12–14px
- Medium weight
- No neon glow
- Hover: slightly brighter blue, subtle lift

Secondary button:
- Transparent or dark surface
- Border: `#334155`
- Text: `#DCE6F2`
- Hover: raised surface

### Cards

Cards should be calm and minimal:
- Background: `rgba(17, 23, 34, 0.78)`
- Border: `rgba(148, 163, 184, 0.16)`
- Radius: 18–24px
- Subtle shadow only
- No heavy borders everywhere
- No overuse of cards

### Icons

Use simple line icons. Icons should support understanding, not decorate every line. Use ice blue for system/control concepts, amber for games/activity concepts, steel for neutral infrastructure concepts.

## Imagery

Use product UI, screenshot frames, abstract interface details, grid lines, soft light beams, and subtle depth. Avoid cartoon characters, stock photos, mascot-heavy visuals, random 3D objects, and generic AI blobs.

## Copy tone

Global English. Short, confident, direct.

Tone:
- Open-source but not hobby-looking.
- Technical but not intimidating.
- Community-focused but not childish.

Avoid exaggerated claims like “Discord killer” or “the future of everything.” Use ownership and control language.

Suggested vocabulary:
- own your instance
- voice rooms
- built-in games
- public discovery
- self-hosted
- open-source
- community control
- server health
- apps inside rooms

## Accessibility

- Keep contrast high.
- Avoid saturated colors on dark backgrounds.
- Avoid small unreadable UI text.
- Interactive elements should be clear.
- Do not rely only on color to communicate status.