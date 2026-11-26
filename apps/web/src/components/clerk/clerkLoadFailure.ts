// oxlint-disable-next-line t3code/no-hookless-use-function -- Clerk was removed; this stub keeps the hook-shaped API for its callers.
export function useClerkLoadFailed() {
  return false;
}

export function retryClerkLoad() {
  window.location.reload();
}
