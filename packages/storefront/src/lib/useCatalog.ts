import { useCallback, useEffect, useState } from "react";
import { loadCatalog, type Business, type Item } from "./api";
import { errorText } from "./format";

export function useCatalog() {
  const [state, setState] = useState<{ business: Business; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setState(await loadCatalog());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Stock changes as others order; refresh quietly while the tab is open.
    const t = setInterval(() => !document.hidden && void reload(), 60_000);
    return () => clearInterval(t);
  }, [reload]);

  return { business: state?.business ?? null, items: state?.items ?? [], loading, error, reload };
}
