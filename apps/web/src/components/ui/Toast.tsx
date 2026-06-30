import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';

export type ToastTone = 'success' | 'danger' | 'info';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
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

function ToastCard({ item }: { item: ToastItem }) {
  const { bg, fg, Icon } = TONES[item.tone];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', maxWidth: 380,
      background: bg, color: fg, borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
      fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', lineHeight: 1.4,
    }}>
      <Icon size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{item.message}</span>
    </div>
  );
}

/**
 * ToastProvider — lehké notifikace pro stavové akce (guard toast „Tuto změnu stavu
 * nelze provést — …", success „Stav změněn"). Nahrazuje alert/confirm.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = ++counter;
    setItems((s) => [...s, { id, message, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 120,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
      }}>
        {items.map((t) => <ToastCard key={t.id} item={t} />)}
      </div>
    </ToastContext.Provider>
  );
}
