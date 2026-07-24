import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getPageMeta } from '../config/pageMeta.js';

const PageMetaContext = createContext(null);

export function PageMetaProvider({ children }) {
  const { pathname } = useLocation();
  const routeMeta = useMemo(() => getPageMeta(pathname), [pathname]);
  const [override, setOverride] = useState(null);

  useEffect(() => {
    setOverride(null);
  }, [pathname]);

  const meta = useMemo(
    () => ({
      ...routeMeta,
      ...(override ?? {}),
    }),
    [routeMeta, override],
  );

  const value = useMemo(
    () => ({
      meta,
      setMeta: setOverride,
    }),
    [meta],
  );

  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageMetaContext() {
  const ctx = useContext(PageMetaContext);
  if (!ctx) throw new Error('usePageMetaContext must be used within PageMetaProvider');
  return ctx;
}

/** Override layout title/subtitle/actions for dynamic pages. Pass null to clear on unmount. */
export function usePageMeta(partial) {
  const { setMeta } = usePageMetaContext();

  useEffect(() => {
    if (!partial) {
      setMeta(null);
      return undefined;
    }
    setMeta(partial);
    return () => setMeta(null);
  }, [partial?.title, partial?.subtitle, setMeta]);
}
