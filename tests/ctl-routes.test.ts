import { expect, test } from 'bun:test';
import {
  parseRoutes,
  appendRoute,
  serializeRoutes,
  recognizeRoute,
  resolveRouteCwd,
  routeMatchesPane,
  aggregateUsage,
  orderByLruMru,
  MAX_ROUTES,
  type Route,
} from '../features/tg-ctl/routes';

const R = (id: number, paneId: string, ts: number): Route => ({ id, paneId, ts });

test('parseRoutes: tolerates garbage, keeps valid entries', () => {
  expect(parseRoutes(null)).toEqual([]);
  expect(parseRoutes('not json')).toEqual([]);
  expect(parseRoutes('{}')).toEqual([]);
  expect(parseRoutes(JSON.stringify([{ id: 1, paneId: '%1', ts: 10 }, { id: 'x' }]))).toEqual([
    { id: 1, paneId: '%1', cwd: undefined, ts: 10 },
  ]);
});

test('appendRoute: dedups by id and caps to MAX_ROUTES', () => {
  let routes: Route[] = [];
  for (let i = 0; i < MAX_ROUTES + 50; i++) routes = appendRoute(routes, R(i, '%1', i));
  expect(routes.length).toBe(MAX_ROUTES);
  expect(routes[0].id).toBe(50); // oldest 50 dropped
  // re-appending an existing id moves it to the end, no duplicate
  routes = appendRoute(routes, R(60, '%2', 999));
  expect(routes.filter((r) => r.id === 60).length).toBe(1);
  expect(routes[routes.length - 1]).toMatchObject({ id: 60, paneId: '%2', ts: 999 });
});

test('serialize → parse round-trips', () => {
  const routes = [R(1, '%1', 10), { id: 2, paneId: '%2', cwd: '/x', ts: 20 }];
  expect(parseRoutes(serializeRoutes(routes))).toEqual([
    { id: 1, paneId: '%1', cwd: undefined, ts: 10 },
    { id: 2, paneId: '%2', cwd: '/x', ts: 20 },
  ]);
});

test('recognizeRoute: last matching id wins, else null', () => {
  const routes = [R(1, '%1', 10), R(2, '%2', 20)];
  expect(recognizeRoute(routes, 2)?.paneId).toBe('%2');
  expect(recognizeRoute(routes, 99)).toBeNull();
});

test('aggregateUsage: recency (max ts) + frequency (count) per pane', () => {
  const usage = aggregateUsage([R(1, '%1', 10), R(2, '%1', 30), R(3, '%2', 20)]);
  expect(usage.get('%1')).toEqual({ lastTs: 30, count: 2 });
  expect(usage.get('%2')).toEqual({ lastTs: 20, count: 1 });
});

test('orderByLruMru: most recent first, frequency tiebreak, unknown last', () => {
  const usage = aggregateUsage([
    R(1, '%a', 100),
    R(2, '%b', 200),
    R(3, '%b', 50),
    R(4, '%c', 200), // same recency as %b, but lower count
  ]);
  // input order deliberately scrambled; %unknown has no history
  const ordered = orderByLruMru(['%c', '%unknown', '%a', '%b'], usage);
  expect(ordered).toEqual(['%b', '%c', '%a', '%unknown']);
});

// --- resolveRouteCwd + routeMatchesPane (reply-routing fix) ---
//
// Regression for: replying to an agent message always opened the picker instead
// of routing to the pane. Root cause = `tg` recorded `process.cwd()` (agents run
// from /tmp) while the daemon compares against the pane's `pane_current_path`, so
// `sameProject` was always false. The fix records the pane path at send time, so
// both sides compare the same quantity.

test('resolveRouteCwd: records the PANE path, not process.cwd() — and the daemon then MATCHES (no picker)', () => {
  // Agent reality: `tg` invoked from /tmp, but the tmux pane sits in the project.
  const processCwd = '/private/tmp';
  const panePath = '/Users/alex/work/my-project';

  const recordedCwd = resolveRouteCwd({ queryPanePath: () => panePath, fallbackCwd: processCwd });

  // The OLD behavior recorded process.cwd() (= /private/tmp). Assert we did NOT.
  expect(recordedCwd).toBe(panePath);
  expect(recordedCwd).not.toBe(processCwd);

  // End-to-end: a route stamped with this cwd, recognized on reply, matches the
  // live pane (whose panePath is the project dir) → routes straight to the pane.
  const routes = appendRoute([], { id: 42, paneId: '%7', cwd: recordedCwd, ts: 100 });
  const recognized = recognizeRoute(parseRoutes(serializeRoutes(routes)), 42);
  expect(recognized).not.toBeNull();
  expect(routeMatchesPane({ recognizedCwd: recognized!.cwd, panePath })).toBe(true);

  // Proof this would FAIL under the old code: had we recorded process.cwd(), the
  // same comparison against the pane path would NOT match → picker.
  expect(routeMatchesPane({ recognizedCwd: processCwd, panePath })).toBe(false);
});

test('resolveRouteCwd: falls back to process.cwd() when not in tmux / query fails or is empty', () => {
  expect(resolveRouteCwd({ queryPanePath: () => null, fallbackCwd: '/p' })).toBe('/p');
  expect(resolveRouteCwd({ queryPanePath: () => '', fallbackCwd: '/p' })).toBe('/p');
});

test('routeMatchesPane: same path matches even when one side is unresolved/relative', () => {
  expect(routeMatchesPane({ recognizedCwd: '/a/b', panePath: '/a/b' })).toBe(true);
  expect(routeMatchesPane({ recognizedCwd: '/a/b/', panePath: '/a/b' })).toBe(true); // trailing slash normalized
});

test('routeMatchesPane: pane-id reuse by a DIFFERENT project still mismatches (04cb6e5 guard preserved)', () => {
  // Same %N, but the pane is now in a different project than the recorded route.
  expect(routeMatchesPane({ recognizedCwd: '/proj-a', panePath: '/proj-b' })).toBe(false);
});

test('routeMatchesPane: absent recorded cwd (old route) or absent pane → no match (picker fallback)', () => {
  expect(routeMatchesPane({ recognizedCwd: undefined, panePath: '/a' })).toBe(false);
  expect(routeMatchesPane({ recognizedCwd: '/a', panePath: undefined })).toBe(false);
});
