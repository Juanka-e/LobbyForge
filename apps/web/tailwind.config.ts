import type { Config } from 'tailwindcss';
import forms from '@tailwindcss/forms';
import containerQueries from '@tailwindcss/container-queries';

/**
 * Calm Future design system tokens, sourced from
 * design_stitch/lobbyforge_calm_future_design_system/DESIGN.md and the
 * code.html references under design_stitch/. The landing and lobby
 * pages assume these names — do not rename without grepping first.
 *
 * The M3 token names (primary-container, on-primary, etc.) match the
 * generated code.html palettes so static design references translate
 * 1:1 to Tailwind classes. `primary` and `primary-container` are
 * intentionally the same ice blue (#8FB8FF) because the landing CTA
 * uses `bg-primary-container` against a `#07101E` text token; the M3
 * primary container maps to "on-primary" text contrast in the M3 spec.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#101419',
        'bg-soft': '#0B1018',
        surface: '#111722',
        'surface-raised': '#171E2B',
        'surface-floating': '#1D2533',
        'surface-container-lowest': '#0b0e13',
        'surface-container-low': '#181c21',
        'surface-container': '#1d2025',
        'surface-container-high': '#272a30',
        'surface-container-highest': '#32353b',
        'surface-variant': '#32353b',
        'surface-dim': '#101419',
        'surface-bright': '#36393f',
        'on-surface': '#e0e2ea',
        'on-surface-variant': '#c3c6d2',
        'on-background': '#e0e2ea',
        'inverse-surface': '#e0e2ea',
        'inverse-on-surface': '#2d3036',
        outline: '#8d919b',
        'outline-variant': '#434750',
        'surface-tint': '#a9c7ff',
        primary: '#8FB8FF',
        'primary-container': '#8FB8FF',
        'on-primary': '#003063',
        'on-primary-container': '#144787',
        'inverse-primary': '#325e9f',
        'primary-fixed': '#d6e3ff',
        'primary-fixed-dim': '#a9c7ff',
        'on-primary-fixed': '#001b3d',
        'on-primary-fixed-variant': '#124686',
        secondary: '#bcc7da',
        'on-secondary': '#26313f',
        'secondary-container': '#3d4757',
        'on-secondary-container': '#abb6c8',
        'secondary-fixed': '#d8e3f6',
        'secondary-fixed-dim': '#bcc7da',
        'on-secondary-fixed': '#111c2a',
        'on-secondary-fixed-variant': '#3d4757',
        tertiary: '#fccb7b',
        'on-tertiary': '#432c00',
        'tertiary-container': '#deb063',
        'on-tertiary-container': '#614200',
        'tertiary-fixed': '#ffdeac',
        'tertiary-fixed-dim': '#efbf70',
        'on-tertiary-fixed': '#281900',
        'on-tertiary-fixed-variant': '#5f4100',
        error: '#ffb4ab',
        'on-error': '#690005',
        'error-container': '#93000a',
        'on-error-container': '#ffdad6',
        'border-subtle': '#263142',
        'border-strong': '#334155',
        'text-primary': '#F4F7FB',
        'text-secondary': '#B7C0CC',
        'text-muted': '#7F8A99',
        success: '#7CCFA6',
        danger: '#E98282',
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
        mockup: '32px',
      },
      spacing: {
        'container-max': '1240px',
        gutter: '24px',
        'margin-desktop': '64px',
        'margin-mobile': '24px',
        'section-gap': '120px',
      },
      fontFamily: {
        'hero-h1': ['Geist', 'sans-serif'],
        'hero-h1-mobile': ['Geist', 'sans-serif'],
        'section-h2': ['Geist', 'sans-serif'],
        'section-h2-mobile': ['Geist', 'sans-serif'],
        'body-md': ['Geist', 'sans-serif'],
        'body-lg': ['Geist', 'sans-serif'],
        'label-sm': ['Geist', 'sans-serif'],
        'label-xs': ['Geist', 'sans-serif'],
      },
      fontSize: {
        'hero-h1': ['80px', { lineHeight: '1.1', letterSpacing: '0', fontWeight: '600' }],
        'hero-h1-mobile': ['40px', { lineHeight: '1.2', fontWeight: '600' }],
        'section-h2': ['52px', { lineHeight: '1.2', fontWeight: '600' }],
        'section-h2-mobile': ['32px', { lineHeight: '1.2', fontWeight: '600' }],
        'body-md': ['16px', { lineHeight: '1.6', fontWeight: '400' }],
        'body-lg': ['18px', { lineHeight: '1.6', fontWeight: '400' }],
        'label-sm': ['14px', { lineHeight: '1.2', letterSpacing: '0.05em', fontWeight: '500' }],
        'label-xs': ['12px', { lineHeight: '1.2', letterSpacing: '0.05em', fontWeight: '500' }],
      },
      boxShadow: {
        mockup:
          'inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 20px 40px -10px rgba(143, 184, 255, 0.05)',
        'mockup-hover':
          'inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 24px 48px -12px rgba(143, 184, 255, 0.08)',
      },
      backgroundImage: {
        'calm-future':
          'radial-gradient(circle at 50% 0%, rgba(143,184,255,0.10), transparent 34%), linear-gradient(180deg, #070A0F 0%, #0B1018 55%, #070A0F 100%)',
      },
      /**
       * Calm Future motion tokens — sourced 1:1 from
       * design_stitch/lobbyforge_animated_desktop_shell/code.html.
       *
       * Naming mirrors the Tailwind convention (`animate-<name>`), so a
       * future Stitch export translates directly. The `@keyframes` blocks
       * are duplicated as raw CSS in globals.css (under the components
       * layer) for non-Tailwind consumers (.stagger-*, .speaking-ring).
       */
      animation: {
        'fade-in-right': 'fadeInRight 0.6s ease-out forwards',
        'fade-in-left': 'fadeInLeft 0.6s ease-out forwards',
        'fade-in-up': 'fadeInUp 0.5s ease-out forwards',
        'pulse-soft': 'pulseSoft 3s ease-in-out infinite',
        'speaking-pulse': 'speakingPulse 2s ease-in-out infinite',
      },
      keyframes: {
        fadeInRight: {
          '0%': { opacity: '0', transform: 'translateX(-20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeInLeft: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        speakingPulse: {
          '0%, 100%': { boxShadow: '0 0 0 2px #7CCFA6' },
          '50%': { boxShadow: '0 0 0 4px rgba(124, 207, 166, 0.4)' },
        },
      },
    },
  },
  plugins: [forms, containerQueries],
};

export default config;
