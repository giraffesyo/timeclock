import { ConfirmModal } from '@parallelworks/ui';
import { type ReactNode, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Field, textareaClass } from '@/components/field';
import { ErrorNote } from '@/components/page';

/**
 * Confirms an approval or a refusal, with the note that goes with it. It
 * stays open when the decision fails and says why.
 */
export function DecisionDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  note: noteMode,
  notePlaceholder,
  errorContext,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Whether a note is asked for, and whether the decision needs one. */
  note: 'none' | 'optional' | 'required';
  notePlaceholder?: string;
  errorContext: string;
  /** Decides. Throw to show the error; resolve 'keep' to leave the dialog open, e.g. after a partial failure. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a handler with nothing to say returns nothing
  onConfirm: (note: string) => Promise<'keep' | void>;
  children?: ReactNode;
}) {
  const t = useTranslations('team.note');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);

  const close = () => {
    setNote('');
    setError(null);
    onClose();
  };

  return (
    <ConfirmModal
      open={open}
      onClose={close}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      destructive={destructive}
      confirmDisabled={noteMode === 'required' && note.trim() === ''}
      closeOnConfirm={false}
      onConfirm={async () => {
        setError(null);
        try {
          if ((await onConfirm(note.trim())) !== 'keep') close();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <div className="space-y-3">
        {children}
        {noteMode !== 'none' && (
          <Field label={noteMode === 'required' ? t('required') : t('optional')}>
            <textarea
              className={`${textareaClass} w-full`}
              value={note}
              maxLength={2000}
              required={noteMode === 'required'}
              placeholder={notePlaceholder}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        )}
        {error !== null && <ErrorNote context={errorContext} error={error} />}
      </div>
    </ConfirmModal>
  );
}
