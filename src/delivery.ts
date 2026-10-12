/** Provider acknowledgements are recorded before any downstream bookkeeping. */
export async function sendOnce(
  alreadyDelivered: boolean,
  send: () => Promise<void>,
  acknowledge: () => Promise<void>
): Promise<boolean> {
  if (alreadyDelivered) return false;
  await send();
  await acknowledge();
  return true;
}
