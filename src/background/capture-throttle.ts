import { MIN_CAPTURE_INTERVAL_MS } from '../shared/constants';

// Chrome allows at most 2 captureVisibleTab calls per second per extension.
// Captures and view-alignment screenshots share one queue. Ephemeral by
// design: after a worker restart the next call simply is not delayed.
let nextAllowedAt = 0;
let queue: Promise<unknown> = Promise.resolve();

export function captureVisibleTabThrottled(
  windowId: number,
  options: chrome.extensionTypes.ImageDetails,
): Promise<string> {
  const run = async () => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAllowedAt = Date.now() + MIN_CAPTURE_INTERVAL_MS;
    return chrome.tabs.captureVisibleTab(windowId, options);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
