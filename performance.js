// Local aggregate measurements only. No telemetry or network requests.
export function recordTiming(metrics, name, duration) {
  if (!Number.isFinite(duration) || duration < 0) return;
  const item = metrics[name] ??= { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  item.count++;
  item.totalMs += duration;
  item.maxMs = Math.max(item.maxMs, duration);
  item.lastMs = duration;
}

export function observeLongTasks(metrics) {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) recordTiming(metrics, "longTask", entry.duration);
  });
  observer.observe({ type: "longtask", buffered: true });
  return observer;
}
