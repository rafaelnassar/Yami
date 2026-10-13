import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  /** Resolved relative to this file (Vite's root is `src/renderer`, not the repo root). */
  content: { relative: true, files: ['./src/renderer/**/*.{ts,tsx,html}'] },
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
        },
        /**
         * Legacy aliases → same graphite identity as semantic tokens.
         * Prefer background/foreground/card/muted/… in new code.
         */
        bg: 'hsl(var(--background) / <alpha-value>)',
        surface: 'hsl(var(--card) / <alpha-value>)',
        'surface-2': 'hsl(var(--muted) / <alpha-value>)',
        'surface-hover': 'hsl(var(--accent) / <alpha-value>)',
        'border-2': 'hsl(var(--border-2) / <alpha-value>)',
        'border-3': 'hsl(var(--border-3) / <alpha-value>)',
        text: 'hsl(var(--foreground) / <alpha-value>)',
        'text-2': 'hsl(var(--text-2) / <alpha-value>)',
        'text-3': 'hsl(var(--text-3) / <alpha-value>)',
        'text-4': 'hsl(var(--muted-foreground) / <alpha-value>)',
        focus: 'hsl(var(--ring) / <alpha-value>)',
        'accent-hot': 'hsl(var(--accent-hot) / <alpha-value>)',
        'accent-muted': 'hsl(var(--accent-muted) / <alpha-value>)',
        'accent-glow': 'rgba(255, 255, 255, 0.05)',
        'accent-soft': 'rgba(255, 255, 255, 0.03)',
        ok: 'hsl(var(--ok) / <alpha-value>)',
        warn: 'hsl(var(--warn) / <alpha-value>)',
        err: 'hsl(var(--destructive) / <alpha-value>)',
        'err-strong': 'hsl(var(--err-strong) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)'
      },
      borderRadius: {
        /** Semantic hierarchy — do not collapse to a single token. */
        sm: 'var(--radius-small)',
        md: 'var(--radius-control)',
        lg: 'var(--radius-surface)',
        xl: 'var(--radius-surface-lg)',
        '2xl': 'var(--radius-surface-lg)'
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', '"Consolas"', 'ui-monospace', 'monospace']
      },
      fontSize: {
        /** Present comfortable scale (13 → 14 → 16 → 18 → 22 → 24). */
        '2xs': ['13px', '18px'],
        xs: ['14px', '20px'],
        sm: ['16px', '24px'],
        base: ['16px', '24px'],
        md: ['18px', '26px'],
        lg: ['22px', '30px'],
        xl: ['24px', '32px']
      },
      boxShadow: {
        panel: '0 12px 28px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.03)',
        'panel-lg': '0 18px 44px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.035)',
        float: '0 8px 20px rgba(0, 0, 0, 0.38)',
        inset: 'inset 0 1px 0 rgba(255, 255, 255, 0.035)',
        'glow-accent': '0 0 10px theme(colors.accent-glow)',
        'glow-accent-sm': '0 0 6px theme(colors.accent-glow)',
        'glow-accent-lg': '0 0 12px theme(colors.accent-glow)'
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-expo': 'cubic-bezier(0.7, 0, 0.84, 0)'
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.35' }
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        },
        /**
         * Centered dialog enter/exit. Keeps translate(-50%, -50%) in every
         * keyframe so the panel rises straight up (no diagonal from zoom+left-1/2).
         */
        'dialog-enter': {
          from: { opacity: '0', transform: 'translate(-50%, calc(-50% + 0.75rem))' },
          to: { opacity: '1', transform: 'translate(-50%, -50%)' }
        },
        'dialog-exit': {
          from: { opacity: '1', transform: 'translate(-50%, -50%)' },
          to: { opacity: '0', transform: 'translate(-50%, calc(-50% + 0.5rem))' }
        }
      },
      animation: {
        'pulse-soft': 'pulse 1.4s ease-in-out infinite',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'dialog-in': 'dialog-enter 0.2s cubic-bezier(0.16, 1, 0.3, 1) both',
        'dialog-out': 'dialog-exit 0.15s cubic-bezier(0.7, 0, 0.84, 0) both'
      }
    }
  },
  plugins: [animate]
} satisfies Config;
