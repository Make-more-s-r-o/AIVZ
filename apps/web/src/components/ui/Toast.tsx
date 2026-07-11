import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';

export type ToastTone = 'success' | 'danger' | 'info';

/** Volitelná akce v toastu (např. „Pokračovat v generování" po potvrzení cen). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  /** Doba do automatického zmizení (ms). Toast s akcí drží déle, ať stihne uživatel kliknout. */
  durationMs?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

let counter = 0;

const TONES: Record<ToastTone, { bg: string; fg: string; Icon: typeof Info }> = {
  success: { bg: 'var(--success-bg)', fg: 'var(--success-fg)', Icon: CheckCircle2 },
  danger: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', Icon: AlertTriangle },
  info: { bg: 'var(--surface-inverse)', fg: 'var(--text-on-inverse)', Icon: Info },
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { bg, fg, Icon } = TONES[item.tone];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', maxWidth: 380,
      background: bg, color: fg, borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
      fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', lineHeight: 1.4,
    }}>
      <Icon size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <span>{item.message}</span>
        {item.action && (
          <button
            type="button"
            onClick={() => { item.action!.onClick(); onDismiss(item.id); }}
            style={{
              alignSelf: 'flex-start', padding: '4px 12px', borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-default, #fff)', color: 'var(--text-default, #111)',
              fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-semibold)',
              border: 'none', cursor: 'pointer',
            }}
          >
            {item.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ToastProvider — lehké notifikace pro stavové akce (guard toast „Tuto změnu stavu
 * nelze provést — …", success „Stav změněn"). Nahrazuje alert/confirm.
 * Volitelně nese akční tlačítko (money-gate „Pokračovat v generování" po potvrzení cen).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((s) => s.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, tone: ToastTone = 'info', options?: ToastOptions) => {
    const id = ++counter;
    setItems((s) => [...s, { id, message, tone, action: options?.action }]);
    // Toast s akcí drží déle (10s), ať uživatel stihne kliknout; jinak výchozích 4,2s.
    const duration = options?.durationMs ?? (options?.action ? 10000 : 4200);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), duration);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 120,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
      }}>
        {items.map((t) => <ToastCard key={t.id} item={t} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}
