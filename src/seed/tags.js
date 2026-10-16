export function agentTag(agentId) {
  return JSON.stringify({ kind: 'agent', agentId });
}

export function terminalTag(where) {
  return JSON.stringify({ kind: 'user', where: `terminal:${where}` });
}

export function followerTag(device) {
  return JSON.stringify({ kind: 'user', where: `follower:${device}` });
}

export function followerDevice(tag) {
  try {
    const { kind, where } = JSON.parse(tag);
    return kind === 'user' && typeof where === 'string' && where.startsWith('follower:')
      ? where.slice('follower:'.length)
      : null;
  } catch {
    return null;
  }
}
