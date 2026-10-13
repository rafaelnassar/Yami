/**
 * Per-domain cookie rules. Rows are edited locally; valid rows are committed to
 * the host (`cookies.setBindings`) after a short pause in typing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CookieBindingDto } from '../../../../shared/contracts/dto.ts';
import { newId } from '../../../../shared/kernel/ids.ts';
import { useServices } from '../../../app/services-context.tsx';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { Input } from '../../../shared/ui/input.tsx';
import { Label } from '../../../shared/ui/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../shared/ui/select.tsx';
import { errorText, key } from '../../notices/notices-store.ts';
import {
  committableBindings,
  isValidRow,
  mergeHostBindings,
  removeRow,
  sameBindings,
  updateRow,
  type BindingRow
} from './cookie-bindings-draft.ts';

const COMMIT_DELAY_MS = 500;

export function CookieBindingsEditor({
  bindings,
  files
}: {
  bindings: readonly CookieBindingDto[];
  files: readonly string[];
}) {
  const t = useT();
  const { cookies, notices } = useServices();
  const [rows, setRows] = useState<readonly BindingRow[]>(bindings);
  const dirty = useRef(false);
  const fileSet = useMemo(() => new Set(files), [files]);

  // Adopt host changes (our own commit, other window, cookie deleted) unless the
  // user is mid-edit; rows that were never committed (still being typed) survive.
  useEffect(() => {
    if (!dirty.current) setRows((current) => mergeHostBindings(current, bindings, fileSet));
  }, [bindings, fileSet]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => {
      dirty.current = false;
      const next = committableBindings(rows, fileSet);
      if (sameBindings(next, bindings)) return;
      void cookies
        .getState()
        .setBindings(next)
        .then((error) => {
          if (error)
            notices
              .getState()
              .push({ kind: 'error', title: key('ui.settings.cookies.rulesFail'), message: errorText(error) });
        });
    }, COMMIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [bindings, cookies, fileSet, notices, rows]);

  const edit = (next: readonly BindingRow[]): void => {
    dirty.current = true;
    setRows(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
        <div>
          <h3 className="type-heading m-0">{t.t('ui.settings.cookies.rules')}</h3>
          <p className="m-0 mt-1 type-caption">{t.t('ui.settings.cookies.rulesHint')}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => edit([...rows, { id: newId('cb'), siteHost: '', cookieName: files[0] ?? '' }])}
        >
          <Plus strokeWidth={1.75} aria-hidden />
          {t.t('ui.settings.cookies.newRule')}
        </Button>
      </div>
      <ul className="m-0 list-none space-y-3 p-0">
        {rows.map((row) => {
          const invalid = row.siteHost.trim().length > 0 && !isValidRow(row, fileSet);
          return (
            <li key={row.id} className="rounded-lg border border-border bg-input/90 p-3 sm:p-4">
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={`cookie-host-${row.id}`} className="text-xs text-text-3">
                    {t.t('ui.settings.cookies.host')}
                  </Label>
                  <Input
                    id={`cookie-host-${row.id}`}
                    value={row.siteHost}
                    onChange={(event) => edit(updateRow(rows, row.id, { siteHost: event.target.value }))}
                    placeholder={t.t('ui.settings.cookies.hostPlaceholder')}
                    aria-invalid={invalid}
                    className="font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={`cookie-file-${row.id}`} className="text-xs text-text-3">
                    {t.t('ui.settings.cookies.file')}
                  </Label>
                  <Select
                    value={fileSet.has(row.cookieName) ? row.cookieName : '__none__'}
                    onValueChange={(value) =>
                      edit(updateRow(rows, row.id, { cookieName: value === '__none__' ? '' : value }))
                    }
                  >
                    <SelectTrigger id={`cookie-file-${row.id}`}>
                      <SelectValue placeholder={t.t('ui.settings.cookies.chooseFile')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t.t('ui.settings.cookies.chooseFile')}</SelectItem>
                      {files.map((file) => (
                        <SelectItem key={file} value={file}>
                          {file}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="md"
                  iconOnly
                  variant="danger"
                  onClick={() => edit(removeRow(rows, row.id))}
                  aria-label={t.t('ui.settings.cookies.removeRule')}
                  title={t.t('ui.settings.cookies.removeRule')}
                >
                  <Trash2 strokeWidth={1.75} aria-hidden />
                </Button>
              </div>
              {invalid ? <p className="m-0 mt-2 text-2xs text-err">{t.t('ui.settings.cookies.ruleInvalid')}</p> : null}
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-4">
            {t.t('ui.settings.cookies.emptyRules')}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
