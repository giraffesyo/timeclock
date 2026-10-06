import { ConfirmModal } from '@parallelworks/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { api, type Schemas, unwrap } from '@/api/client';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { usePeople, useProjects } from '@/lib/queries';
import { dayToDate } from '@/lib/time';

const key = ['integrations', 'toggl'];
type Status = Schemas['TogglStatus'];
type Issue = Schemas['TogglIssue'];
type Preview = Schemas['TogglPreview'];

export function TogglIntegration() {
  const t = useTranslations('integrations.toggl');
  const format = useFormatter();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const status = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await api.GET('/api/v1/integrations/toggl')),
    refetchInterval: 20_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const sync = useMutation({
    mutationFn: async () => unwrap(await api.POST('/api/v1/integrations/toggl/sync')),
    onSuccess: () => {
      toast.success(t('queued'));
      return refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: async () => unwrap(await api.DELETE('/api/v1/integrations/toggl')),
    onSuccess: () => {
      setDisconnecting(false);
      setEditing(false);
      toast.success(t('disconnected'));
      return refresh();
    },
  });
  if (status.isPending) return <Loading />;
  if (status.isError) return <ErrorNote error={status.error} />;
  const saved = status.data;
  return (
    <Panel title={t('title')}>
      <div className="space-y-5">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        {!saved.available && !saved.connected ? (
          <p className="text-sm">{t('unavailable')}</p>
        ) : (
          <>
            {saved.connected && (
              <div className="space-y-3">
                <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">{t('workspace')}</dt>
                    <dd className="mt-1 font-medium">{saved.workspaceId}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('matchedPeople')}</dt>
                    <dd className="mt-1 font-medium">{(saved.people ?? []).length}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('lastSync')}</dt>
                    <dd className="mt-1">
                      {saved.lastSync
                        ? format.dateTime(new Date(saved.lastSync), { dateStyle: 'medium', timeStyle: 'short' })
                        : t('awaitingSync')}
                    </dd>
                  </div>
                </dl>
                <Roles saved={saved} />
                <p role="status" className="text-sm text-muted-foreground">
                  {saved.historyComplete
                    ? t('historyComplete')
                    : saved.historyThrough
                      ? t('historyProgress', { date: saved.historyThrough })
                      : t('historyPending')}
                </p>
                {saved.error && (
                  <div role="status" className="space-y-1 text-sm">
                    <p>{saved.error}</p>
                    {saved.nextSync && (
                      <p className="text-muted-foreground">
                        {t('retryAt', {
                          time: format.dateTime(new Date(saved.nextSync), { dateStyle: 'medium', timeStyle: 'short' }),
                        })}
                      </p>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={sync.isPending}
                    disabled={!!saved.error || !saved.available}
                    onClick={() => sync.mutate()}
                  >
                    {t('syncNow')}
                  </Button>
                  <Button disabled={!saved.available} onClick={() => setEditing(!editing)}>
                    {editing ? t('cancel') : t('manage')}
                  </Button>
                  <Button variant="danger" onClick={() => setDisconnecting(true)}>
                    {t('disconnect')}
                  </Button>
                </div>
                {sync.isError && <ErrorNote error={sync.error} />}
              </div>
            )}
            {saved.available && (!saved.connected || editing) && (
              <Setup
                saved={saved}
                onSaved={() => {
                  setEditing(false);
                  void refresh();
                }}
              />
            )}
            {(saved.issues ?? []).length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">{t('needsAttention', { count: (saved.issues ?? []).length })}</h3>
                {(saved.issues ?? []).map((issue) =>
                  issue.timeOff ? (
                    <TimeOffIssue key={issue.entryId} issue={issue} />
                  ) : (
                    <Conflict key={`${issue.entryId}:${issue.version}`} issue={issue} onResolved={refresh} />
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ConfirmModal
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title={t('disconnectTitle')}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        destructive
        closeOnConfirm={false}
        onConfirm={() => disconnect.mutateAsync()}
      >
        {disconnect.isError && <ErrorNote error={disconnect.error} />}
      </ConfirmModal>
    </Panel>
  );
}

const roleKeys = ['holidayProject', 'vacationProject', 'sickProject'] as const;
type Roles = Record<(typeof roleKeys)[number], number>;

/** The projects that stand for time away, and since when. */
function Roles({ saved }: { saved: Status }) {
  const t = useTranslations('integrations.toggl');
  const format = useFormatter();
  const roles = [
    { key: 'holidayProject', id: saved.holidayProject, name: saved.holidayName, from: saved.holidayFrom },
    { key: 'vacationProject', id: saved.vacationProject, name: saved.vacationName, from: saved.vacationFrom },
    { key: 'sickProject', id: saved.sickProject, name: saved.sickName, from: saved.sickFrom },
  ] as const;
  if (!roles.some((r) => r.id)) return null;
  return (
    <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
      {roles.map((r) => (
        <div key={r.key}>
          <dt className="text-muted-foreground">{t(r.key)}</dt>
          <dd className="mt-1">
            {r.id && r.from
              ? t('roleFrom', {
                  name: r.name || t('roleUnnamed', { id: r.id }),
                  date: format.dateTime(dayToDate(r.from), { dateStyle: 'medium' }),
                })
              : t('noRole')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Setup({ saved, onSaved }: { saved: Status; onSaved: () => void }) {
  const t = useTranslations('integrations.toggl');
  const client = useQueryClient();
  const people = usePeople();
  const [token, setToken] = useState('');
  const [workspace, setWorkspace] = useState(saved.workspaceId || 0);
  const [from, setFrom] = useState(saved.from && saved.from !== '1970-01-01' ? saved.from : '');
  const [allHistory, setAllHistory] = useState(!saved.from || saved.from === '1970-01-01');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [loadedWorkspace, setLoadedWorkspace] = useState(0);
  const [roles, setRoles] = useState<Roles>({
    holidayProject: saved.holidayProject ?? 0,
    vacationProject: saved.vacationProject ?? 0,
    sickProject: saved.sickProject ?? 0,
  });
  const discover = useMutation({
    mutationFn: async (id: number) =>
      unwrap(await api.POST('/api/v1/integrations/toggl/preview', { body: { token, workspaceId: id } })),
    onSuccess: (data, id) => {
      setPreview(data);
      setLoadedWorkspace(id);
      setMatches(
        Object.fromEntries(
          [...(data.suggested ?? []), ...(saved.people ?? [])].map((p) => [String(p.userId), p.personId]),
        ),
      );
      void client.invalidateQueries({ queryKey: ['people'] });
    },
  });
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PUT('/api/v1/integrations/toggl', {
          body: {
            token,
            workspaceId: workspace,
            from: allHistory ? '' : from,
            people: Object.entries(matches)
              .filter(([, personId]) => !!personId)
              .map(([id, personId]) => ({ userId: Number(id), personId })),
            ...roles,
          },
        }),
      ),
    onSuccess: () => {
      setToken('');
      setPreview(null);
      toast.success(t('connected'));
      onSaved();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4 border-t border-border pt-4">
      <Field label={t('token')} hint={saved.connected ? t('tokenKept') : t('tokenHint')}>
        <input
          className={controlClass}
          type="password"
          autoComplete="off"
          value={token}
          maxLength={256}
          onChange={(e) => {
            setToken(e.target.value);
            setPreview(null);
            setLoadedWorkspace(0);
          }}
        />
      </Field>
      <Button
        loading={discover.isPending}
        disabled={!token && !saved.connected}
        onClick={() => discover.mutate(workspace)}
      >
        {t('findWorkspaces')}
      </Button>
      {discover.isError && <ErrorNote error={discover.error} />}
      {preview && (
        <>
          <Field label={t('workspace')}>
            <select
              className={controlClass}
              value={workspace || ''}
              disabled={saved.connected}
              onChange={(e) => {
                const id = Number(e.target.value);
                setWorkspace(id);
                setLoadedWorkspace(0);
                if (id) discover.mutate(id);
              }}
            >
              <option value="">{t('chooseWorkspace')}</option>
              {(preview.workspaces ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {(preview.workspaces ?? []).length === 0 && <p className="text-sm">{t('noWorkspaces')}</p>}
          {loadedWorkspace === workspace && workspace > 0 && (
            <>
              <Field label={t('history')} hint={t('fromHint')}>
                <select
                  className={controlClass}
                  value={allHistory ? 'all' : 'date'}
                  disabled={saved.connected}
                  onChange={(e) => setAllHistory(e.target.value === 'all')}
                >
                  <option value="all">{t('allHistory')}</option>
                  <option value="date">{t('chooseDate')}</option>
                </select>
              </Field>
              {!allHistory && (
                <Field label={t('from')}>
                  <input
                    className={controlClass}
                    type="date"
                    required
                    value={from}
                    disabled={saved.connected}
                    max={new Date().toISOString().slice(0, 10)}
                    min="1970-01-01"
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </Field>
              )}
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('matchPeople')}</h3>
                <p className="text-sm text-muted-foreground">{t('matchHint')}</p>
                {people.isPending && <Loading />}
                {people.isError && <ErrorNote error={people.error} />}
                {(preview.users ?? [])
                  .filter((u) => !u.inactive)
                  .map((u) => (
                    <Field key={u.user_id} label={u.name || u.email} hint={u.name ? u.email : undefined}>
                      <select
                        className={controlClass}
                        value={matches[String(u.user_id)] ?? ''}
                        disabled={(saved.people ?? []).some((p) => p.userId === u.user_id)}
                        onChange={(e) => setMatches({ ...matches, [String(u.user_id)]: e.target.value })}
                      >
                        <option value="">{t('doNotSync')}</option>
                        {people.data
                          ?.filter((p) => p.active)
                          .map((p) => (
                            <option
                              key={p.id}
                              value={p.id}
                              disabled={Object.entries(matches).some(
                                ([id, person]) => Number(id) !== u.user_id && person === p.id,
                              )}
                            >
                              {p.name || p.email}
                            </option>
                          ))}
                      </select>
                    </Field>
                  ))}
                {(preview.users ?? []).length === 0 && <p className="text-sm">{t('noPeople')}</p>}
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('roles')}</h3>
                <p className="max-w-2xl text-sm text-muted-foreground">{t('rolesHint')}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {roleKeys.map((role) => (
                    <Field key={role} label={t(role)}>
                      <select
                        className={controlClass}
                        value={roles[role] || ''}
                        onChange={(e) => setRoles({ ...roles, [role]: Number(e.target.value) || 0 })}
                      >
                        <option value="">{t('noRole')}</option>
                        {(preview.projects ?? []).map((p) => (
                          <option
                            key={p.id}
                            value={p.id}
                            disabled={roleKeys.some((other) => other !== role && roles[other] === p.id)}
                          >
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">{t('scope')}</p>
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={discover.isPending || !Object.values(matches).some(Boolean)}
              >
                {saved.connected ? t('saveConnection') : t('connect')}
              </Button>
              {save.isError && <ErrorNote error={save.error} />}
            </>
          )}
        </>
      )}
    </form>
  );
}

/** A day whose Toggl vacation or sick entries can't become time off yet. Fixed in Toggl or by clearing the day; nothing to choose here. */
function TimeOffIssue({ issue }: { issue: Issue }) {
  const t = useTranslations('integrations.toggl');
  const format = useFormatter();
  const people = usePeople();
  const kinds = ['locked', 'time_off_exists', 'invalid_entry'] as const;
  const kind = kinds.find((k) => k === issue.kind) ?? 'invalid_entry';
  const person = people.data?.find((p) => p.id === issue.personId);
  const off = issue.timeOff;
  if (!off) return null;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div>
        <h4 className="text-sm font-medium">{person?.name || issue.personId}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{t(`timeOffIssues.${kind}`)}</p>
      </div>
      <dl className="text-sm">
        <dt className="font-medium">{t('togglVersion')}</dt>
        <dd className="mt-1 text-muted-foreground">
          {t('timeOffSummary', {
            kind: off.kind,
            hours: format.number(off.hours, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            day: format.dateTime(dayToDate(off.day), { dateStyle: 'medium' }),
          })}
        </dd>
      </dl>
    </section>
  );
}

function Conflict({ issue, onResolved }: { issue: Issue; onResolved: () => Promise<unknown> }) {
  const t = useTranslations('integrations.toggl');
  const format = useFormatter();
  const people = usePeople();
  const projects = useProjects(true);
  const [remoteId, setRemoteId] = useState('');
  const [choice, setChoice] = useState<'local' | 'remote' | 'retry' | 'link' | null>(null);
  const resolve = useMutation({
    mutationFn: async () => {
      if (!choice) return;
      unwrap(
        await api.POST('/api/v1/integrations/toggl/entries/{id}/resolve', {
          params: { path: { id: issue.entryId } },
          body: { choice, version: issue.version, remoteId: Number(remoteId) || 0 },
        }),
      );
    },
    onSuccess: async () => {
      setChoice(null);
      await onResolved();
    },
  });
  const kinds = [
    'conflict',
    'missing_remote',
    'ownership_changed',
    'creation_uncertain',
    'locked',
    'project_required',
    'project_unavailable',
    'description_required',
    'invalid_entry',
  ] as const;
  const kind = kinds.find((k) => k === issue.kind) ?? 'invalid_entry';
  const person = people.data?.find((p) => p.id === issue.personId);
  const summary = (state: Issue['local']) =>
    state.deleted
      ? t('deletedEntry')
      : `${state.note || t('noDescription')} · ${projects.data?.find((p) => p.id === state.projectId)?.name || t('noProject')} · ${format.dateTime(new Date(state.start), { dateStyle: 'medium', timeStyle: 'short' })}${state.end ? ` – ${format.dateTime(new Date(state.end), { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div>
        <h4 className="text-sm font-medium">{person?.name || issue.personId}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{t(`issues.${kind}`)}</p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">{t('timeclockVersion')}</dt>
          <dd className="mt-1 break-words text-muted-foreground">{summary(issue.local)}</dd>
        </div>
        <div>
          <dt className="font-medium">{t('togglVersion')}</dt>
          <dd className="mt-1 break-words text-muted-foreground">{summary(issue.remote)}</dd>
        </div>
      </dl>
      {kind === 'creation_uncertain' ? (
        <div className="space-y-3">
          <Field label={t('existingId')}>
            <input
              className={controlClass}
              type="number"
              min="1"
              value={remoteId}
              onChange={(e) => setRemoteId(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!remoteId} onClick={() => setChoice('link')}>
              {t('linkExisting')}
            </Button>
            <Button onClick={() => setChoice('retry')}>{t('confirmAbsent')}</Button>
          </div>
        </div>
      ) : kind === 'conflict' || kind === 'missing_remote' ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setChoice('local')}>{t('keepLocal')}</Button>
          <Button onClick={() => setChoice('remote')}>{t('keepRemote')}</Button>
        </div>
      ) : null}
      <ConfirmModal
        open={choice !== null}
        onClose={() => setChoice(null)}
        title={t('resolveTitle')}
        description={choice === 'retry' ? t('retryWarning') : t('resolveDescription')}
        confirmLabel={t('confirmChoice')}
        closeOnConfirm={false}
        onConfirm={() => resolve.mutateAsync()}
      >
        {resolve.isError && <ErrorNote error={resolve.error} />}
      </ConfirmModal>
    </section>
  );
}
