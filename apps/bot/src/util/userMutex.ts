/**
 * Per-user serialization. When a user fires two slash commands or button
 * interactions in quick succession (or two parallel /resolve clicks at the
 * same instant), we don't want them racing the DB / chain. Instead we queue
 * by discordId — at most one task per user runs at a time.
 *
 * Usage:
 *   await serializeForUser(userId, async () => { ... });
 *
 * Internally an in-process Map<discordId, Promise> chain. Each new task
 * appends to the chain via .then(); the chain only ever advances, never
 * rejects (errors from the inner task propagate to the caller of
 * serializeForUser, but the chain itself swallows them so the next task
 * can still run).
 */
const queues = new Map<string, Promise<unknown>>();

const SLOW_LOG_THRESHOLD_MS = 250;

export async function serializeForUser<T>(
  userId: string,
  task: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const prev = queues.get(userId) ?? Promise.resolve();
  let resolveOuter!: (value: T) => void;
  let rejectOuter!: (err: unknown) => void;
  const outer = new Promise<T>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });
  // Append to the chain. Chain ALWAYS resolves so subsequent tasks aren't blocked.
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const waited = Date.now() - start;
      if (waited > SLOW_LOG_THRESHOLD_MS) {
        console.log(
          `[userMutex] user=${userId} waited ${waited}ms in queue`,
        );
      }
      try {
        const result = await task();
        resolveOuter(result);
      } catch (e) {
        rejectOuter(e);
      }
    });
  queues.set(userId, next);
  // Clean up the map entry once this task is the tail (avoid memory growth)
  next.finally(() => {
    if (queues.get(userId) === next) {
      queues.delete(userId);
    }
  });
  return outer;
}

/** Test/dev: clear all queues (after tests). */
export function _resetUserMutex() {
  queues.clear();
}
