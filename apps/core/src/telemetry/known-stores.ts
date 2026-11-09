// The stores an Admin API `{storeId}` may be labelled with (#729). A path parameter is caller input: a 401 with a
// made-up uuid must not mint a metric series, so only an id the registry knows becomes a `store_id` value.
// Refreshed lazily (on use, at most every `refreshMs`), never on a timer, and a failed load keeps the last set.

export interface KnownStores {
  has(storeId: string): boolean;
}

export interface KnownStoreSet extends KnownStores {
  /** Resolves when the first load has settled (tests, boot logging). */
  readonly ready: Promise<void>;
}

export function knownStoreSet(
  load: () => Promise<Iterable<string>>,
  opts: { refreshMs?: number; now?: () => number } = {},
): KnownStoreSet {
  const refreshMs = opts.refreshMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let ids = new Set<string>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    loading ??= load()
      .then((next) => {
        ids = new Set(next);
        loadedAt = now();
      })
      .catch(() => {
        // keep the previous set; retried on the next use after refreshMs
        loadedAt = now();
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  const ready = refresh();
  return {
    ready,
    has(storeId) {
      if (now() - loadedAt >= refreshMs) void refresh();
      return ids.has(storeId);
    },
  };
}
