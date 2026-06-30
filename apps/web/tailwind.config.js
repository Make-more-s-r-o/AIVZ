/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // VZ CRM design-system tokens (see src/styles/tokens/*.css).
      // Existing default gray/blue/green/etc. utilities are left intact;
      // these add semantic + stage names that reference the CSS variables.
      fontFamily: {
        sans: ['IBM Plex Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          soft: 'var(--accent-soft-bg)',
          on: 'var(--accent-on)',
        },
        surface: {
          page: 'var(--surface-page)',
          card: 'var(--surface-card)',
          sunken: 'var(--surface-sunken)',
          hover: 'var(--surface-hover)',
          selected: 'var(--surface-selected)',
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
        },
        line: {
          subtle: 'var(--border-subtle)',
          DEFAULT: 'var(--border-default)',
          strong: 'var(--border-strong)',
        },
        success: { DEFAULT: 'var(--success-solid)', bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
        danger: { DEFAULT: 'var(--danger-solid)', bg: 'var(--danger-bg)', fg: 'var(--danger-fg)' },
        warning: { DEFAULT: 'var(--warning-solid)', bg: 'var(--warning-bg)', fg: 'var(--warning-fg)' },
        info: { DEFAULT: 'var(--info-solid)', bg: 'var(--info-bg)', fg: 'var(--info-fg)' },
      },
      borderRadius: {
        token: 'var(--radius-md)',
        'token-lg': 'var(--radius-lg)',
      },
      boxShadow: {
        focus: 'var(--shadow-focus)',
        token: 'var(--shadow-md)',
      },
      maxWidth: {
        content: 'var(--content-max)',
      },
    },
  },
  plugins: [],
};
