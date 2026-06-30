import { Fragment, type CSSProperties } from 'react';
import { PROCESSING_STEPS } from '../../lib/stages';

export type StepItem = string | { label: string };

export interface StageStepperProps {
  steps?: StepItem[];
  current?: number;
  style?: CSSProperties;
}

/**
 * StageStepper — horizontal progress stepper for the tender detail header.
 * Renders an ordered list of stages with a done/current/upcoming state.
 * Defaults to the 5 processing steps (Extrakce → Analýza → Ocenění →
 * Generování → Validace) that drive lifecycle transitions.
 */
export function StageStepper({ steps = [...PROCESSING_STEPS], current = 0, style }: StageStepperProps) {
  const items = steps.map((s) => (typeof s === 'string' ? { label: s } : s));
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', ...style }}>
      {items.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <Fragment key={i}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <span style={{
                width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-semibold)',
                background: done ? 'var(--success-solid)' : active ? 'var(--accent)' : 'var(--gray-100)',
                color: done || active ? '#fff' : 'var(--text-tertiary)',
                border: active ? '2px solid var(--accent)' : 'none',
                boxShadow: active ? '0 0 0 3px var(--accent-soft-bg)' : 'none',
              }}>
                {done ? (
                  <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : i + 1}
              </span>
              <span style={{
                fontSize: 'var(--font-size-2xs)', fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                color: done ? 'var(--success-fg)' : active ? 'var(--accent)' : 'var(--text-tertiary)', whiteSpace: 'nowrap',
              }}>{s.label}</span>
            </div>
            {i < items.length - 1 && (
              <span style={{ flex: 1, height: 2, margin: '0 6px', marginBottom: 18, background: done ? 'var(--success-solid)' : 'var(--gray-200)', borderRadius: 1 }} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
