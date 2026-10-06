import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { Avatar } from '@parallelworks/ui';
import { CheckIcon } from '@parallelworks/ui/icons';
import { controlClass } from '@/components/field';
import { cn } from '@/lib/cn';

/** Someone to choose, or a choice that isn't a person ("Don't sync") when it has no picture. */
export interface PersonChoice {
  value: string;
  label: string;
  /** Shown as a picture, with initials when it is empty. Absent shows none. */
  avatarUrl?: string;
  disabled?: boolean;
}

/** People as choices, by name. */
export const personChoices = (people: { id: string; name: string; email?: string; avatarUrl: string }[]) =>
  people.map((p) => ({ value: p.id, label: p.name || p.email || p.id, avatarUrl: p.avatarUrl }));

function Choice({ choice }: { choice: PersonChoice }) {
  return (
    <>
      {choice.avatarUrl !== undefined && (
        <Avatar src={choice.avatarUrl} name={choice.label} size="sm" className="shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
    </>
  );
}

/** A choice of person, each with their picture. */
export function PersonSelect({
  value,
  onChange,
  choices,
  label,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: PersonChoice[];
  /** The control's accessible name. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const current = choices.find((c) => c.value === value);
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <ListboxButton
        aria-label={label}
        className={cn(controlClass, 'flex cursor-pointer items-center gap-2 text-left', className)}
      >
        {current ? <Choice choice={current} /> : <span className="flex-1" />}
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden>
          <path d="m5 6 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        className="popover z-[10000] max-h-72 w-(--button-width) min-w-56 overflow-y-auto p-1 [--anchor-gap:4px] [--anchor-padding:8px] focus:outline-none"
      >
        {choices.map((c) => (
          <ListboxOption
            key={c.value}
            value={c.value}
            disabled={c.disabled}
            className="group flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus:bg-muted"
          >
            <Choice choice={c} />
            <CheckIcon className="invisible size-3.5 shrink-0 text-primary group-data-selected:visible" aria-hidden />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
