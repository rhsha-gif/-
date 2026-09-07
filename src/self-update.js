// Compatibility for already-installed hooks. Updates are explicit, never a
// background mutation while another session is using the generated files.
export async function refreshIfStale() {
  return { refreshed: false, reason: 'explicit-update-required' };
}
