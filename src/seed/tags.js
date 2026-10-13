export function agentTag(agentId) {
  return JSON.stringify({ kind: 'agent', agentId });
}

export function terminalTag(where) {
  return JSON.stringify({ kind: 'user', where: `terminal:${where}` });
}

export function followerTag(device) {
  return JSON.stringify({ kind: 'user', where: `follower:${device}` });
}
