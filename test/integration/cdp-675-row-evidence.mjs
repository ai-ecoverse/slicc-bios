export async function captureRowPageEvidence(page, row) {
  if (row.ownerClosed?.success) return;
  row.guardConnections = await page.evaluate(
    (floor) =>
      [...(globalThis.cdp675Connections?.values() ?? [])]
        .filter(({ connectionId }) => connectionId > floor)
        .map(({ connectionId }) => connectionId),
    row.guardConnectionFloor
  );
  row.methods = await page
    .evaluate((start) => globalThis.cdp675Trace?.slice(start ?? 0) ?? [], row.traceStart)
    .catch(() => []);
  row.frameReadTrace = await page
    .evaluate(
      (target) =>
        (globalThis.cdp675FrameReadTrace ?? []).filter(({ targetId }) => targetId === target),
      row.target
    )
    .catch(() => []);
  row.worldTrace = await page
    .evaluate(
      (target) => (globalThis.cdp675WorldTrace ?? []).filter(({ targetId }) => targetId === target),
      row.target
    )
    .catch(() => []);
  row.privateDocumentTrace = await page
    .evaluate(
      (target) =>
        (globalThis.cdp675PrivateDocumentTrace ?? []).filter(({ targetId }) => targetId === target),
      row.target
    )
    .catch(() => []);
  row.publicationTrace = await page
    .evaluate(
      (target) =>
        (globalThis.cdp675PublicationTrace ?? []).filter(({ targetId }) => targetId === target),
      row.target
    )
    .catch(() => []);
  row.framePredicateTrace = await page
    .evaluate(
      (target) =>
        (globalThis.cdp675FramePredicateTrace ?? []).filter(({ targetId }) => targetId === target),
      row.target
    )
    .catch(() => []);
}
