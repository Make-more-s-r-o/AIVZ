import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Coins, ClipboardCheck, Clock, FileCheck2, WandSparkles } from 'lucide-react';
import {
  getInbox, runInboxBulk, type InboxBulkResult, type InboxEntry, type InboxSort,
} from '../lib/api';
import { fmtCZK } from '../lib/format';
import { STAGE_LABELS, type StageKey } from '../lib/stages';
import { Card, Badge, Button, Select } from '../components/ui';

export interface InboxPageProps {
  onOpen?: (id: string) => void;
}

type BulkAction = 'generate' | 'finalize';

function CountBadge({ count, tone, icon }: { count: number; tone: 'danger' | 'warning'; icon: React.ReactNode }) {
  if (count <= 0) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  return <Badge tone={tone} size="sm"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{icon}{count}</span></Badge>;
}

const GRID = '34px minmax(210px, 2fr) 105px 105px 65px 115px 90px 105px minmax(105px, 1fr) minmax(105px, 1fr)';
const HEAD = ['', 'Zakázka', 'Stav', 'Lhůta', 'Skóre', 'Nepotvrzené', 'HARD flagy', 'Validace', 'Zisk', 'Nabídková cena'];

export default function InboxPage({ onOpen }: InboxPageProps) {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<InboxSort>('deadline_score');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<BulkAction | null>(null);
  const [result, setResult] = useState<{ action: BulkAction; data: InboxBulkResult } | null>(null);
  const { data: entries = [], isLoading, isError } = useQuery({
    queryKey: ['inbox', sort], queryFn: () => getInbox(sort), refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: ({ action, ids }: { action: BulkAction; ids: string[] }) => runInboxBulk(action, ids),
    onSuccess: (data, variables) => {
      setResult({ action: variables.action, data });
      setSelected(new Set());
      setConfirmAction(null);
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  const visibleIds = entries.map((entry) => entry.tender_id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectedIds = [...selected].filter((id) => visibleIds.includes(id));

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', margin: 0 }}>Ke schválení</h1>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            Zakázky čekající na lidskou kontrolu, generování nebo finalizaci.
          </p>
        </div>
        <div style={{ width: 245 }}>
          <Select size="sm" value={sort} onChange={(event) => setSort(event.target.value as InboxSort)} options={[
            { value: 'deadline_score', label: 'Nejbližší lhůta, pak skóre' },
            { value: 'score_deadline', label: 'Nejvyšší skóre, pak lhůta' },
          ]} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Button size="sm" iconLeft={<WandSparkles size={14} />} disabled={selectedIds.length === 0 || mutation.isPending} onClick={() => setConfirmAction('generate')}>
          Generovat vybrané
        </Button>
        <Button size="sm" variant="secondary" iconLeft={<FileCheck2 size={14} />} disabled={selectedIds.length === 0 || mutation.isPending} onClick={() => setConfirmAction('finalize')}>
          Finalizovat vybrané
        </Button>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>Vybráno: {selectedIds.length}</span>
      </div>

      {mutation.isError && <ResultPanel error={mutation.error instanceof Error ? mutation.error.message : 'Akce se nezdařila.'} />}
      {result && <ResultPanel result={result} />}

      <Card padding={0}>
        <div className="vz-scroll" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1170 }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12, padding: '0 16px', height: 40, background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-default)' }}>
              <input type="checkbox" aria-label="Vybrat všechny zakázky" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))} />
              {HEAD.slice(1).map((heading, index) => <span key={heading} style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', textAlign: index >= 2 ? 'center' : 'left' }}>{heading}</span>)}
            </div>
            {isLoading ? <Empty text="Načítám…" /> : isError ? <Empty text="Inbox se nepodařilo načíst." /> : entries.length === 0 ? (
              <div style={{ padding: '40px 24px', textAlign: 'center' }}><CheckCircle2 size={28} style={{ color: 'var(--color-success, #16a34a)', marginBottom: 8 }} /><div>Vše je čisté</div></div>
            ) : entries.map((entry) => <InboxRow key={entry.tender_id} entry={entry} checked={selected.has(entry.tender_id)} onToggle={() => toggle(entry.tender_id)} onOpen={onOpen} />)}
          </div>
        </div>
      </Card>

      {confirmAction && <ConfirmDialog action={confirmAction} count={selectedIds.length} pending={mutation.isPending} onCancel={() => setConfirmAction(null)} onConfirm={() => mutation.mutate({ action: confirmAction, ids: selectedIds })} />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)' }}>{text}</div>;
}

function deadlineLabel(hours: number | null): string {
  if (hours == null) return '—';
  if (hours < 0) return `${Math.abs(hours)} h po lhůtě`;
  if (hours < 1) return 'za <1 h';
  return `za ${hours} h`;
}

function InboxRow({ entry, checked, onToggle, onOpen }: { entry: InboxEntry; checked: boolean; onToggle: () => void; onOpen?: (id: string) => void }) {
  const stage = entry.crm_stav ? (STAGE_LABELS[entry.crm_stav as StageKey] ?? entry.crm_stav) : '—';
  const cell = { fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', textAlign: 'center' as const };
  return <div onClick={() => onOpen?.(entry.tender_id)} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12, padding: '0 16px', minHeight: 58, background: entry.deadline_alarm ? 'var(--danger-bg, #fef2f2)' : 'transparent', borderLeft: entry.deadline_alarm ? '3px solid var(--danger-fg, #dc2626)' : '3px solid transparent', borderBottom: '1px solid var(--border-subtle, var(--border-default))', cursor: 'pointer' }}>
    <input type="checkbox" aria-label={`Vybrat ${entry.nazev}`} checked={checked} onClick={(event) => event.stopPropagation()} onChange={onToggle} />
    <span style={{ minWidth: 0 }}><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>{entry.nazev}</strong><small style={{ color: 'var(--text-tertiary)' }}>{entry.tender_id}</small>{entry.data_error && <span style={{ display: 'block' }}><Badge tone="danger" size="sm">Vadná data</Badge></span>}</span>
    <span style={cell}>{stage}</span>
    <span style={{ ...cell, color: entry.deadline_alarm ? 'var(--danger-fg, #dc2626)' : cell.color }}><Clock size={12} style={{ verticalAlign: -2, marginRight: 3 }} />{deadlineLabel(entry.hodin_do_lhuty)}</span>
    <span style={cell}>{entry.score == null ? '—' : Math.round(entry.score)}</span>
    <span style={cell}><CountBadge count={entry.nepotvrzene_ceny} tone="warning" icon={<Coins size={12} />} /></span>
    <span style={cell}><CountBadge count={entry.hard_flagy} tone="danger" icon={<AlertTriangle size={12} />} /></span>
    <span style={cell}><CountBadge count={entry.validation_fails} tone="danger" icon={<ClipboardCheck size={12} />} /></span>
    <span style={{ ...cell, textAlign: 'right', color: entry.zisk_kc != null && entry.zisk_kc > 0 ? 'var(--color-success, #16a34a)' : 'var(--text-secondary)' }}>{entry.zisk_kc != null ? fmtCZK(entry.zisk_kc) : '—'}</span>
    <span style={{ ...cell, textAlign: 'right' }}>{entry.celkova_cena_s_dph != null ? fmtCZK(entry.celkova_cena_s_dph) : '—'}</span>
  </div>;
}

function ConfirmDialog({ action, count, pending, onCancel, onConfirm }: { action: BulkAction; count: number; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const generate = action === 'generate';
  return <div role="dialog" aria-modal="true" aria-labelledby="bulk-title" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'center', padding: 20 }}>
    <Card style={{ width: 'min(480px, 100%)' }}>
      <h2 id="bulk-title" style={{ marginTop: 0 }}>{generate ? 'Generovat vybrané zakázky?' : 'Finalizovat vybrané zakázky?'}</h2>
      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>Akce zkontroluje {count} {count === 1 ? 'zakázku' : 'zakázky'}. Pokračují jen zakázky se všemi platně potvrzenými cenami a bez HARD flagu. Ostatní budou vyřazeny s uvedeným důvodem. Žádná cena se automaticky nepotvrdí.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="secondary" disabled={pending} onClick={onCancel}>Zrušit</Button><Button disabled={pending} onClick={onConfirm}>{pending ? 'Probíhá…' : (generate ? 'Spustit generování' : 'Spustit finalizaci')}</Button></div>
    </Card>
  </div>;
}

function reasonCzech(reason: string, detail: any): string {
  if (reason === 'unconfirmed_items') return `${detail?.count ?? detail?.items?.length ?? 0} nepotvrzené položky`;
  if (reason === 'hard_flag') return `${detail?.count ?? detail?.flags?.length ?? 1} HARD cenový flag`;
  if (reason === 'not_ready') return detail?.reason ?? 'Nabídka není připravená k podání';
  if (reason === 'stale_documents') return 'Vygenerované dokumenty neodpovídají aktuálním cenám';
  if (reason === 'already_running') return 'Generování už probíhá';
  if (reason === 'not_found') return 'Zakázka nebyla nalezena';
  if (reason === 'invalid_data') return 'Cenová data chybí nebo jsou poškozená';
  if (reason === 'governance_disabled') return 'Akce byla zastavena nastavením governance';
  return detail?.reason ?? reason;
}

function detailCzech(detail: any): string[] {
  const values = [
    ...(Array.isArray(detail?.problems) ? detail.problems : []),
    ...(Array.isArray(detail?.items) ? detail.items : []),
  ];
  return values.slice(0, 3).map((value: unknown) => String(value));
}

function ResultPanel({ result, error }: { result?: { action: BulkAction; data: InboxBulkResult }; error?: string }) {
  if (error) return <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--danger-fg)', borderRadius: 8, color: 'var(--danger-fg)' }}>{error}</div>;
  if (!result) return null;
  return <div aria-live="polite" style={{ marginBottom: 12, padding: 12, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--surface-card)', fontSize: 'var(--font-size-sm)' }}>
    <strong>{result.action === 'generate' ? 'Výsledek generování' : 'Výsledek finalizace'}</strong>
    <div style={{ marginTop: 6, color: 'var(--color-success, #16a34a)' }}>Spuštěno: {result.data.started.length ? result.data.started.join(', ') : 'žádná zakázka'}</div>
    {result.data.skipped.length > 0 && <div style={{ marginTop: 6, color: 'var(--danger-fg, #dc2626)' }}>Vyřazeno:<ul style={{ margin: '4px 0 0' }}>{result.data.skipped.map((item) => {
      const details = detailCzech(item.detail);
      return <li key={item.id}>{item.id}: {reasonCzech(item.reason, item.detail)}{details.length > 0 && <span> — podrobnosti: {details.join('; ')}</span>}</li>;
    })}</ul></div>}
  </div>;
}
