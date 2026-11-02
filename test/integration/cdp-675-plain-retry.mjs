export function plainReplayAttempts(methods) {
  const sends = methods.filter(
    ({ boundary, direction }) => boundary === 'bios' && direction === 'send'
  );
  const reload = sends.find(({ packet }) => packet.method === 'Page.reload');
  if (!reload) return null;
  const attach = sends.find(
    ({ at, connectionId, packet }) =>
      at >= reload.at &&
      connectionId === reload.connectionId &&
      packet.method === 'Target.attachToTarget'
  );
  if (!attach) return null;
  const reply = (sent) =>
    methods.find(
      ({ at, boundary, direction, connectionId, packet }) =>
        at >= sent.at &&
        boundary === 'bios' &&
        direction === 'receive' &&
        connectionId === sent.connectionId &&
        packet.id === sent.packet.id
    );
  const attached = reply(attach);
  const sessionId = attached?.packet.result?.sessionId;
  const attempts = [];
  for (const sent of sends) {
    if (
      !sessionId ||
      sent.at < attach.at ||
      sent.connectionId !== attach.connectionId ||
      sent.packet.sessionId !== sessionId ||
      sent.packet.method !== 'Runtime.enable'
    )
      continue;
    const answer = reply(sent);
    attempts.push({
      at: sent.at,
      sinceReloadMs: sent.at - reload.at,
      id: sent.packet.id,
      sessionId,
      replyAt: answer?.at,
      outcome: answer?.packet.error ? 'refused' : answer?.packet.result ? 'accepted' : 'unanswered',
      error: answer?.packet.error,
    });
    if (answer?.packet.result) break;
  }
  return {
    reloadAt: reload.at,
    attachAt: attach.at,
    attachReplyAt: attached?.at,
    attachError: attached?.packet.error,
    sessionId,
    attemptCount: attempts.length,
    attempts,
  };
}
