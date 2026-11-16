// lazydev-integrate.mjs - pure helpers for the request_integration tool.

// Order the tasks that will be merged: done tasks only, topological by depends_on
// (walking through skipped dependencies), ties broken by the task order in the spec.
export function mergeOrder(tasks, statusById) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set(tasks.filter((t) => statusById.get(t.id) === 'done').map((t) => t.id));
  const pending = new Set(done);

  const ancestors = (id, seen = new Set()) => {
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (seen.has(d) || !byId.has(d)) continue;
      seen.add(d);
      ancestors(d, seen);
    }
    return seen;
  };
  const deps = new Map(tasks.map((t) => [t.id, [...ancestors(t.id)].filter((a) => done.has(a))]));

  const out = [];
  while (pending.size) {
    // tasks keeps spec order, so the first ready task also wins ties.
    const next = tasks.find((t) => pending.has(t.id) && deps.get(t.id).every((d) => !pending.has(d)));
    if (!next) break; // cycle guard: emit what is left in task order
    out.push(next.id);
    pending.delete(next.id);
  }
  if (pending.size) out.push(...tasks.filter((t) => pending.has(t.id)).map((t) => t.id));
  return out;
}
