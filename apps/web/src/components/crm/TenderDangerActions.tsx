import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Trash2, RotateCcw } from 'lucide-react';
import { Button, useToast } from '../ui';
import { archiveTender, restoreTender, deleteTender, purgeTender } from '../../lib/api';
import { getStoredUser } from '../../lib/auth';
import ConfirmNameDialog from './ConfirmNameDialog';

export interface TenderDangerActionsProps {
  tenderId: string;
  tenderName: string;
  archived?: boolean;
  deleted?: boolean;
  /** compact = kompaktní ikonové tlačítka do řádku seznamu; jinak plná tlačítka s popiskem. */
  compact?: boolean;
  /** Zavolá se po úspěšné akci (invalidace už proběhla) — např. návrat zpět po smazání. */
  onChanged?: (action: 'archived' | 'unarchived' | 'deleted' | 'restored' | 'purged') => void;
}

type Role = 'admin' | 'analytik' | 'viewer' | undefined;

/**
 * Akce archivace / soft-delete / obnova / trvalé smazání zakázky.
 * RBAC (zrcadlí backend requireRole): archivovat/mazat/obnovit → admin|analytik;
 * trvalé smazání (purge) → jen admin. Bez role (dev bez JWT) se povolí vše.
 */
export default function TenderDangerActions({
  tenderId, tenderName, archived, deleted, compact, onChanged,
}: TenderDangerActionsProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'soft' | 'purge'>(null);

  const role = getStoredUser()?.role as Role;
  const canManage = role !== 'viewer'; // admin|analytik|undefined(dev)
  const canPurge = role === 'admin' || role === undefined;

  async function refresh() {
    // Prefix ['tenders', ...] pokryje seznam, summary i bucket varianty.
    await qc.invalidateQueries({ queryKey: ['tenders'] });
    await qc.invalidateQueries({ queryKey: ['tender-status', tenderId] });
  }

  async function run(fn: () => Promise<unknown>, ok: string, action: Parameters<NonNullable<typeof onChanged>>[0]) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      toast(ok, 'success');
      onChanged?.(action);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Akce selhala', 'danger');
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  if (!canManage) return null;

  const iconSize = compact ? 15 : 16;
  const size = compact ? 'sm' : 'md';

  return (
    <>
      {deleted ? (
        <>
          <Button
            variant={compact ? 'ghost' : 'secondary'}
            size={size}
            iconLeft={<RotateCcw size={iconSize} />}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); void run(() => restoreTender(tenderId), 'Zakázka obnovena', 'restored'); }}
            title="Obnovit z koše"
          >
            {compact ? '' : 'Obnovit'}
          </Button>
          {canPurge && (
            <Button
              variant={compact ? 'ghost' : 'danger'}
              size={size}
              iconLeft={<Trash2 size={iconSize} style={compact ? { color: 'var(--danger-solid)' } : undefined} />}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); setDialog('purge'); }}
              title="Trvale smazat"
            >
              {compact ? '' : 'Trvale smazat'}
            </Button>
          )}
        </>
      ) : (
        <>
          <Button
            variant={compact ? 'ghost' : 'secondary'}
            size={size}
            iconLeft={archived ? <ArchiveRestore size={iconSize} /> : <Archive size={iconSize} />}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void run(() => archiveTender(tenderId, !archived),
                archived ? 'Zakázka odarchivována' : 'Zakázka archivována',
                archived ? 'unarchived' : 'archived');
            }}
            title={archived ? 'Odarchivovat' : 'Archivovat'}
          >
            {compact ? '' : (archived ? 'Odarchivovat' : 'Archivovat')}
          </Button>
          <Button
            variant="ghost"
            size={size}
            iconLeft={<Trash2 size={iconSize} style={{ color: 'var(--danger-solid)' }} />}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); setDialog('soft'); }}
            title="Smazat (do koše)"
          >
            {compact ? '' : 'Smazat'}
          </Button>
        </>
      )}

      <ConfirmNameDialog
        open={dialog === 'soft'}
        expectedName={tenderName}
        title="Smazat zakázku"
        description={<>Zakázka se přesune do <strong>Koše</strong>. Soubory ani data se nesmažou a lze ji kdykoli obnovit.</>}
        confirmLabel="Smazat do koše"
        loading={busy}
        onConfirm={() => void run(() => deleteTender(tenderId), 'Zakázka přesunuta do koše', 'deleted')}
        onClose={() => setDialog(null)}
      />
      <ConfirmNameDialog
        open={dialog === 'purge'}
        expectedName={tenderName}
        title="Trvale smazat zakázku"
        danger
        description={<><strong>Nevratná akce.</strong> Smažou se všechny soubory zakázky (vstupy i výstupy) a veškerá data v CRM (úkoly, termíny, komentáře, štítky, výsledky, nákupy, historie). Tuto akci nelze vzít zpět.</>}
        confirmLabel="Trvale smazat"
        loading={busy}
        onConfirm={() => void run(() => purgeTender(tenderId), 'Zakázka trvale smazána', 'purged')}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
