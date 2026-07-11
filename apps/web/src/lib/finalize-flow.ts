export const FINALIZED_DOWNLOAD_ERROR =
  'Zakázka finalizována, ale stažení selhalo — stáhněte znovu z Dokumentů.';

interface FinalizeDeps {
  finalize: () => Promise<unknown>;
  invalidate: () => void;
}

/** Invalidace stavu proběhne vždy po pokusu o finalizaci, i když brána finalizaci odmítne. */
export async function finalizeWithInvalidation(deps: FinalizeDeps): Promise<void> {
  try {
    await deps.finalize();
  } finally {
    deps.invalidate();
  }
}
