import { onSite, sevenHost, validPolicy } from '../seed/seven-rule.js';

export const MCP_CALLBACK = '/oauth/mcp-callback';
export const AGENT = '/opt/agent/';
export const AGENT_REFUSED =
  'sw: seven doesn’t run on this address, so it serves nothing from its agent here';
export const POLICY_UNAVAILABLE = 'sw: seven’s policy is unavailable. Reload through the BIOS.';

export const fromAgent = (asked) => asked === MCP_CALLBACK || asked.startsWith(AGENT);

export async function agentRefused(asked, at, policy) {
  if (!fromAgent(asked) || !onSite(at)) return null;
  const seven = await Promise.resolve()
    .then(policy)
    .catch(() => null);
  if (!validPolicy(seven)) return { status: 503, text: POLICY_UNAVAILABLE };
  if (!sevenHost(seven, at)) return { status: 403, text: AGENT_REFUSED };
  return null;
}
