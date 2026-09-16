import { useCallback, useEffect, useState } from 'react';
import { preferencesApi, getErrorMessage } from '../services/api.js';

/**
 * Shared table-column preference state (mirrors the AdminUsers pattern).
 *
 * - `allColumns`: [{ key, label, always? }] — full toggleable inventory.
 * - `defaultVisible`: keys shown on first visit (no saved preference) or on error.
 * - Server prefs win once saved; the `saved` flag distinguishes "never saved"
 *   (full server registry) from a deliberate user selection.
 */
export function normalizeTableColumns(allColumns, keys, defaultVisible) {
  const valid = new Set(allColumns.map((column) => column.key));
  const always = allColumns.filter((column) => column.always).map((column) => column.key);
  const filtered = (Array.isArray(keys) ? keys : []).filter((key) => valid.has(key));
  for (const key of always) {
    if (!filtered.includes(key)) filtered.unshift(key);
  }
  return filtered.length > 0 ? filtered : [...defaultVisible];
}

function columnsToPayload(visibleKeys) {
  return visibleKeys.map((key, order) => ({ key, order, width: null, pinned: null }));
}

export function useTableColumns({ tableKey, allColumns, defaultVisible }) {
  const [visibleColumns, setVisibleColumns] = useState(defaultVisible);
  // Draft edited inside the panel; only applied to the table on Done.
  const [draftColumns, setDraftColumns] = useState(null);
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [columnsError, setColumnsError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setColumnsLoading(true);
      setColumnsError('');
      try {
        const response = await preferencesApi.getTablePreference(tableKey);
        if (cancelled) return;
        if (response?.data?.saved === false) {
          setVisibleColumns([...defaultVisible]);
        } else {
          const keys = (response?.data?.columns ?? []).map((column) => column.key);
          setVisibleColumns(normalizeTableColumns(allColumns, keys, defaultVisible));
        }
      } catch (err) {
        if (cancelled) return;
        setColumnsError(getErrorMessage(err));
        setVisibleColumns([...defaultVisible]);
      } finally {
        if (!cancelled) setColumnsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tableKey, allColumns, defaultVisible]);

  const saveColumnPreferences = useCallback(
    async (nextVisibleColumns) => {
      setColumnsError('');
      try {
        await preferencesApi.updateTablePreference(tableKey, {
          columns: columnsToPayload(nextVisibleColumns),
        });
      } catch (err) {
        setColumnsError(getErrorMessage(err));
        throw err;
      }
    },
    [tableKey],
  );

  const isColumnVisible = useCallback(
    (key) => visibleColumns.includes(key),
    [visibleColumns],
  );

  const openColumnEditor = useCallback(() => {
    setDraftColumns([...visibleColumns]);
    setEditorOpen(true);
  }, [visibleColumns]);

  const cancelColumnEdit = useCallback(() => {
    setDraftColumns(null);
    setEditorOpen(false);
  }, []);

  const isDraftColumnVisible = useCallback(
    (key) => (draftColumns ?? visibleColumns).includes(key),
    [draftColumns, visibleColumns],
  );

  const handleDraftColumnToggle = useCallback(
    (key) => {
      if (allColumns.find((column) => column.key === key)?.always) return;
      setDraftColumns((prev) => {
        const base = prev ?? visibleColumns;
        const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
        return normalizeTableColumns(allColumns, next, defaultVisible);
      });
    },
    [allColumns, defaultVisible, visibleColumns],
  );

  const applyColumnPreferences = useCallback(() => {
    const normalized = normalizeTableColumns(
      allColumns,
      draftColumns ?? visibleColumns,
      defaultVisible,
    );
    const previous = visibleColumns;
    // Optimistic apply + close; rollback only if the server persist fails.
    setVisibleColumns(normalized);
    setDraftColumns(null);
    setEditorOpen(false);
    saveColumnPreferences(normalized).catch(() => {
      setVisibleColumns(previous);
    });
  }, [allColumns, defaultVisible, draftColumns, visibleColumns, saveColumnPreferences]);

  return {
    visibleColumns,
    columnsLoading,
    columnsError,
    editorOpen,
    setEditorOpen,
    openColumnEditor,
    cancelColumnEdit,
    isColumnVisible,
    isDraftColumnVisible,
    handleDraftColumnToggle,
    applyColumnPreferences,
  };
}
