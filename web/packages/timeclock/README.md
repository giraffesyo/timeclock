# @giraffesyo/timeclock

The [Timeclock](https://github.com/giraffesyo/timeclock) clock for a host application: start, stop and move the clock from your own header, without sending people to Timeclock's pages.

It talks to a Timeclock mounted on the same origin (for example at `/timeclock`), as the person your application has signed in. There are three layers; use the lowest one that does what you need.

```sh
npm install @giraffesyo/timeclock
```

## The bar

A ready-made bar: what you are working on, the project, the running time, and a start/stop button. It draws nothing until Timeclock has answered, and nothing for someone Timeclock doesn't know.

```tsx
import { ClockBar } from '@giraffesyo/timeclock/react';
import '@giraffesyo/timeclock/styles.css';

<ClockBar
  basePath="/timeclock"
  onError={(err, action) => notify(`Couldn't ${action}: ${err.message}`)}
  onSwitched={(entry) => notify('Moved the clock')}
/>;
```

- While the clock runs, choosing another project moves the clock to it without stopping: the time so far stays on the project it was on.
- The note saves when the field is left; a note typed just before choosing a project goes with the new stretch.
- The running time is a button: it opens the start and stop, to move when the stretch started (its time, or another day from a calendar) or to stop it at an earlier time. It saves when it closes; Escape leaves it as it was.
- `labels` replaces any of its words, for another language or voice.
- Colors come from `--tc-*` custom properties. They default to [@parallelworks/ui](https://www.npmjs.com/package/@parallelworks/ui)'s theme tokens (`--theme-*`) when the page has them, and to plain light values when it doesn't. Set `--tc-bg`, `--tc-fg`, `--tc-muted`, `--tc-border`, `--tc-hover`, `--tc-accent`, `--tc-accent-fg` and `--tc-stop` on an ancestor to fit another look.

`ProjectPicker` and `ProjectDot` are exported too.

## The button

For a header with no room for the bar: a small button that says "Clock in", or shows the project's color and the time while the clock runs (`1:23`), and opens the bar in a panel beneath it.

```tsx
import { ClockButton } from '@giraffesyo/timeclock/react';
import '@giraffesyo/timeclock/styles.css';

<ClockButton
  basePath="/timeclock"
  href="https://clock.example.com/"
  className="my-header-button"
  onError={(err, action) => notify(`Couldn't ${action}: ${err.message}`)}
/>;
```

- It keeps its place while Timeclock is loading, so the header doesn't shift when it appears.
- `className` goes on the button, to match the header's other buttons; `href` adds an "Open Timeclock" link under the bar.
- The panel is a native popover: Escape or a click elsewhere closes it. It takes the bar's callbacks and labels, plus `clockIn`, `stopped`, `running`, `noProject` and `open`.

## The hook

The clock with no look, to draw your own:

```tsx
import { useClock } from '@giraffesyo/timeclock/react';

function HeaderClock() {
  const clock = useClock({ basePath: '/timeclock' });
  if (clock.status !== 'ready') return null;
  return clock.running ? (
    <button onClick={() => clock.stop()}>Stop</button>
  ) : (
    <button onClick={() => clock.start()}>Start</button>
  );
}
```

`useClock()` gives the state (`status`, `running`, `projects`, `requireProject`, `requireDescription`, `locked`, `timeZone`, `busy`), what is being typed (`note`, `setNote`, `projectId`), and what can be done (`start`, `stop`, `chooseProject`, `saveNote`, `saveTimes`, `resume`). Everything that changes the clock returns a promise that rejects with a `ClockError` when Timeclock refuses.

## The store

No React at all:

```ts
import { clockFor } from '@giraffesyo/timeclock';

const clock = clockFor('/timeclock');
const stop = clock.subscribe(() => render(clock.getState()));
await clock.start({ projectId, note: 'Standup' });
```

`clockFor(basePath)` is one store for the page, so everything showing the clock agrees. While something is subscribed it asks Timeclock again every minute and whenever the tab comes back, since a clock can be stopped from another tab. `createClock(options)` makes a separate one, with your own `fetch` or polling interval.

## Errors

A `ClockError` carries the HTTP `status`, the problem's stable `code` (such as `project_required` or `period_locked`), a `message` in English, and the RFC 9457 problem itself as `body`.

## Versions

The package follows the server's API under `/api/v1`. A host should run a Timeclock at least as new as the package it uses.
