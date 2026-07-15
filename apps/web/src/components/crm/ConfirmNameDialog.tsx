import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Button, Input } from '../ui';

export interface ConfirmNameDialogProps {
  open: boolean;
  /** Název zakázky, který musí uživatel přepsat pro potvrzení. */
  expectedName: string;
  title: string;
  /** Popisný text nad polem (např. co se stane). */
  description: React.ReactNode;
  confirmLabel: string;
  /** danger = nevratná akce (červené tlačítko + varovná ikona). */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Modální potvrzení akce, které vyžaduje přesné přepsání názvu zakázky.
 * Používá se pro soft-delete i trvalé smazání (purge) zakázky.
 */
export default function ConfirmNameDialog({
  open, expectedName, title, description, confirmLabel, danger, loading, onConfirm, onClose,
}: ConfirmNameDialogProps) {
  const [value, setValue] = useState('');

  // Reset pole při každém otevření.
  useEffect(() => { if (open) setValue(''); }, [open]);

  // Escape zavírá.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const matches = value.trim() === expectedName.trim();

  const overlay: CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  };
  const panel: CSSProperties = {
    background: 'var(--surface-card)', border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)', width: 'min(480px, 100%)', padding: 20,
    boxShadow: 'var(--shadow-lg, 0 10px 40px rgba(0,0,0,0.3))',
  };

  return createPortal(
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {danger && <AlertTriangle size={18} style={{ color: 'var(--danger, #dc2626)' }} />}
            <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)' }}>
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Zavřít"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {description}
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginBottom: 6 }}>
            Pro potvrzení přepište název zakázky: <strong style={{ color: 'var(--text-secondary)' }}>{expectedName}</strong>
          </label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Název zakázky…"
            autoFocus
          />
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Zrušit</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!matches || loading}
          >
            {loading ? 'Pracuji…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
