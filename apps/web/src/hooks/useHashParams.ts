import { useState, useEffect, useCallback } from 'react';

/**
 * Hook pro parsování a nastavování query params z hash URL.
 * Formát: #/warehouse?q=HP&cat=5&sort=price&dir=desc&p=2
 */
export function useHashParams() {
  const parseParams = useCallback(() => {
    const hash = window.location.hash.slice(1) || '/';
    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return new URLSearchParams();
    return new URLSearchParams(hash.slice(qIdx + 1));
  }, []);

  const [params, setParamsState] = useState<URLSearchParams>(parseParams);

  useEffect(() => {
    const handler = () => setParamsState(parseParams());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [parseParams]);

  const setParams = useCallback((updater: (prev: URLSearchParams) => URLSearchParams) => {
    const hash = window.location.hash.slice(1) || '/';
    const qIdx = hash.indexOf('?');
    const basePath = qIdx === -1 ? hash : hash.slice(0, qIdx);

    const current = parseParams();
    const next = updater(current);

    // Odstraň prázdné hodnoty
    const cleaned = new URLSearchParams();
    next.forEach((v, k) => {
      if (v) cleaned.set(k, v);
    });

    const qs = cleaned.toString();
    window.location.hash = qs ? `${basePath}?${qs}` : basePath;
  }, [parseParams]);

  const getParam = useCallback((key: string): string | null => {
    return params.get(key);
  }, [params]);

  const setParam = useCallback((key: string, value: string | null) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (value === null || value === '') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  }, [setParams]);

  return { params, getParam, setParam, setParams };
}
