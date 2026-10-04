import { deriveTheme, isDarkColor, THEME_PRESETS } from '@parallelworks/ui/theme';
import { type CSSProperties, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass } from '@/components/field';
import { ErrorNote, Panel } from '@/components/page';
import { Segmented } from '@/components/segmented';
import { SwitchRow } from '@/components/settings/switch';
import { useSaveTheme } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { currentMode, previewTheme } from '@/lib/theme';
import {
  contrastFailures,
  DEFAULT_THEME,
  type Mode,
  type Scheme,
  schemeFor,
  surfaces,
  type Theme,
} from '@/lib/theme-seeds';

type Draft = Record<Mode, Scheme>;
type Seed = Scheme['interface'];

const HEX = /^#[0-9a-fA-F]{6}$/;
const MODES: Mode[] = ['light', 'dark'];

/** A color: a swatch that opens the system's picker, and its hex to type or paste. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  // The field follows the value when it changes from outside (a preset, the picker).
  const shown = HEX.test(text) && text.toLowerCase() !== value.toLowerCase() ? value : text;
  return (
    <span className="flex items-center gap-2">
      <input
        type="color"
        className="theme-swatch"
        aria-label={label}
        value={value}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
      />
      <input
        className={`${controlClass} w-28 font-mono uppercase`}
        aria-label={label}
        value={shown}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setText(next);
          if (HEX.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </span>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** The three values a surface is derived from. */
function SeedRows({
  seed,
  onChange,
  names,
}: {
  seed: Seed;
  onChange: (seed: Seed) => void;
  names: Record<'accent' | 'background' | 'contrast', string>;
}) {
  const contrast = Math.round((seed.contrast || 1) * 100);
  return (
    <>
      <Row label={names.accent}>
        <ColorField label={names.accent} value={seed.accent} onChange={(accent) => onChange({ ...seed, accent })} />
      </Row>
      <Row label={names.background}>
        <ColorField
          label={names.background}
          value={seed.background}
          onChange={(background) => onChange({ ...seed, background })}
        />
      </Row>
      <Row label={names.contrast}>
        <span className="flex items-center gap-3">
          <input
            type="range"
            className="theme-range w-44"
            aria-label={names.contrast}
            min={50}
            max={150}
            step={5}
            value={contrast}
            onChange={(e) => onChange({ ...seed, contrast: Number(e.target.value) / 100 })}
          />
          <span className="tabular w-8 text-right text-sm text-muted-foreground">{contrast}</span>
        </span>
      </Row>
    </>
  );
}

const draftOf = (theme: Theme): Draft => ({ light: schemeFor(theme, 'light'), dark: schemeFor(theme, 'dark') });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The workspace's look. A few values per mode, and everything else follows:
 * the page shows the draft as it changes, and saving gives it to everyone.
 */
export function Appearance() {
  const t = useTranslations('settings.appearance');
  const tc = useTranslations('common');
  const { info } = useSession();
  const save = useSaveTheme();
  const saved = draftOf(info.theme);
  const [draft, setDraft] = useState<Draft>(saved);
  const [mode, setMode] = useState<Mode>(() => currentMode());
  const scheme = draft[mode];
  const dirty = !same(draft, saved);
  const custom = !!info.workspaceTheme.light?.interface?.accent || !!info.workspaceTheme.dark?.interface?.accent;

  // The page wears the draft while this tab is open.
  useEffect(() => {
    previewTheme({ theme: draft, mode });
    return () => previewTheme(null);
  }, [draft, mode]);

  const set = (next: Scheme) => setDraft({ ...draft, [mode]: next });
  const problems = MODES.flatMap((m) => {
    const s = draft[m];
    const out: string[] = [];
    if (isDarkColor(s.interface.background) !== (m === 'dark')) out.push(t(m === 'dark' ? 'notDark' : 'notLight'));
    for (const pair of contrastFailures(deriveTheme(surfaces(s, m))))
      out.push(t('lowContrast', { mode: t(`mode.${m}`), pair }));
    return out;
  });

  const store = (theme: Theme, done: string) =>
    save.mutate(theme, {
      onSuccess: (next) => {
        setDraft(draftOf(next.theme));
        toast.success(done);
      },
    });
  const names = { accent: t('accent'), background: t('background'), contrast: t('contrast') };
  const presets = [
    { name: 'timeclock', label: t('presets.own'), seed: DEFAULT_THEME.light, dark: DEFAULT_THEME.dark },
    ...THEME_PRESETS.map((p) => ({ name: p.name, label: p.label, seed: p.seed as Scheme, dark: undefined })),
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {custom ? t('isCustom') : info.homeLabel ? t('isHost', { name: info.homeLabel }) : t('isOwn')}
        </p>
        <Segmented<Mode>
          label={t('mode.label')}
          value={mode}
          onChange={setMode}
          options={MODES.map((m) => ({ value: m, label: t(`mode.${m}`) }))}
        />
      </div>

      <Panel flush title={t('interface')}>
        <div className="divide-y divide-border">
          <SeedRows seed={scheme.interface} onChange={(seed) => set({ ...scheme, interface: seed })} names={names} />
        </div>
      </Panel>

      <Panel flush>
        <div className="divide-y divide-border">
          <div className="px-4 py-1">
            <SwitchRow
              label={t('sidebar')}
              hint={t('sidebarHint')}
              value={!!scheme.sidebar}
              onChange={(on) =>
                set({
                  ...scheme,
                  sidebar: on ? { ...(surfaces(scheme, mode).sidebar ?? scheme.interface) } : undefined,
                })
              }
            />
          </div>
          {scheme.sidebar && (
            <SeedRows seed={scheme.sidebar} onChange={(seed) => set({ ...scheme, sidebar: seed })} names={names} />
          )}
        </div>
      </Panel>

      <Panel flush title={t('presets.title')}>
        <div className="flex flex-wrap gap-2 p-4">
          {presets.map((p) => {
            const to: Mode = isDarkColor(p.seed.interface.background) ? 'dark' : 'light';
            return (
              <button
                key={p.name}
                type="button"
                className="theme-preset"
                style={
                  {
                    '--a': p.seed.interface.accent,
                    '--b': p.seed.interface.background,
                    '--s': p.seed.sidebar?.background ?? p.seed.interface.background,
                  } as CSSProperties
                }
                onClick={() => {
                  setDraft(p.dark ? { light: p.seed, dark: p.dark } : { ...draft, [to]: p.seed });
                  if (!p.dark) setMode(to);
                }}
              >
                <span aria-hidden className="theme-preset-swatch" />
                {p.label}
              </button>
            );
          })}
        </div>
      </Panel>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {save.isError && <ErrorNote context={t('saveFailed')} error={save.error} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!dirty || problems.length > 0}
          loading={save.isPending}
          onClick={() => store(draft, t('saved'))}
        >
          {tc('save')}
        </Button>
        <Button disabled={!dirty} onClick={() => setDraft(saved)}>
          {t('discard')}
        </Button>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(draft)).then(
              () => toast.success(t('copied')),
              () => toast.error(t('copyFailed')),
            );
          }}
        >
          {t('copy')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            navigator.clipboard.readText().then(
              (text) => {
                try {
                  const pasted = JSON.parse(text) as Theme;
                  if (!pasted.light?.interface?.accent && !pasted.dark?.interface?.accent)
                    throw new Error('not a theme');
                  setDraft({ light: schemeFor(pasted, 'light'), dark: schemeFor(pasted, 'dark') });
                } catch {
                  toast.error(t('pasteFailed'));
                }
              },
              () => toast.error(t('pasteFailed')),
            );
          }}
        >
          {t('paste')}
        </Button>
        {custom && (
          <Button variant="ghost" disabled={save.isPending} onClick={() => store({}, t('wasReset'))}>
            {t('reset')}
          </Button>
        )}
      </div>
    </div>
  );
}
