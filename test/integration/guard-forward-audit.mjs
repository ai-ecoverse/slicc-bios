export function auditForwards(forwards, commands, probes, sessionId) {
  const used = new Set();
  const answers = (probes ?? []).map((probe) => {
    const want = JSON.stringify(probe.params ?? {});
    const index = commands.findIndex(
      (command, at) =>
        !used.has(at) &&
        command.sessionId === sessionId &&
        command.method === probe.method &&
        JSON.stringify(command.params ?? {}) === want &&
        command.at >= probe.sentAt - 1000
    );
    if (index < 0) return { id: probe.id };
    used.add(index);
    const command = commands[index];
    return {
      id: probe.id,
      forwarded: forwards.some(
        (forward) =>
          forward.id === command.id &&
          forward.sessionId === command.sessionId &&
          forward.method === command.method
      ),
    };
  });
  return {
    complete: answers.every((answer) => typeof answer.forwarded === 'boolean'),
    probes: answers,
  };
}
