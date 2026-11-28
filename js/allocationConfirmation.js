// Recovery never creates IDs or sends another POST. A miss is not proof of failure.
export function isConfirmedAllocation(response, pending, demoMode, mockMode = false) {
  const allocation = response?.allocation;
  return Boolean(response?.ok && response.found && allocation?.ok &&
    response.demoMode === demoMode && allocation.demoMode === demoMode &&
    allocation.requestId === pending.requestId &&
    (allocation.sessionId === pending.sessionId || (mockMode && !allocation.sessionId)) &&
    allocation.participantId && ['allocated', 'paused'].includes(allocation.allocationStatus));
}

export async function confirmAllocation(pending, lookup, { demoMode, mockMode = false,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
  // At most three GETs; stagger arrivals rather than polling at a fixed cadence.
  for (const delay of [1500, 3500, 7000]) {
    await wait(Math.round(delay * (0.8 + random() * 0.4)));
    try {
      const response = await lookup(pending);
      if (isConfirmedAllocation(response, pending, demoMode, mockMode)) return response.allocation;
    } catch { /* Keep the original pending request after network failures. */ }
  }
  return null;
}
