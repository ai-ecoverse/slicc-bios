const ERRNO = new Set([
  'EINVAL',
  'ENOENT',
  'EACCES',
  'EEXIST',
  'EAGAIN',
  'ETIMEDOUT',
  'ENOTCONN',
  'ENOTSUP',
  'EIO',
  'ECANCELED',
]);

export const VAULT_CAUSES = {
  'policy-paused':
    'a credential policy file is missing, so the vault paused secrets; restore /etc/fnox/config.toml or /etc/slicc/secrets-policy.toml',
  'no-placeholder': 'the request carries no placeholder of this vault',
  'url-invalid': 'the request has no valid URL',
  'placeholder-in-url': 'a placeholder works only in a header, not in the URL',
  'placeholder-in-header-name': 'a placeholder works only in a header value, not its name',
  'url-credentials': 'credentials in the URL are refused',
  'insecure-destination': 'credentials are sent only over https on port 443',
  'path-ambiguous': 'the path is ambiguous (encoded dots or slashes)',
  'exit-encoded-bodies': 'this route returns encoded bodies, which the vault cannot scrub',
  'record-removed': 'the credential behind the placeholder was removed; add it again in Settings',
  'record-kind': 'the placeholder is a secret where a model or MCP sign-in goes, or the reverse',
  'record-expired':
    'the sign-in expired and the vault is refreshing it; try again in a minute, or sign in again in Settings',
  'vault-locked': "seven's vault is locked; unlock it in the vault window",
  'no-rule':
    'no [[proxy.rules]] entry in /etc/fnox/config.toml lets this secret be used; add one for this domain, method, path and header',
  'rule-domain':
    "this secret's rules in /etc/fnox/config.toml are for other domains; add a rule for this one",
  'rule-request':
    "this secret's rules in /etc/fnox/config.toml don't allow this method, path or header; widen the one rule that should",
  'rule-exit':
    "/etc/slicc/secrets-policy.toml doesn't allow this secret on this route; add the route to the secret's exits",
  'placeholder-repeated': 'a placeholder appears more than once in one header',
  'mcp-server':
    "the placeholder isn't a sign-in of the MCP server at this URL; sign in to this server in Settings › MCP servers",
  'exit-follows-redirects': "the credential needs a route that doesn't follow redirects",
  'value-overlaps': "the credential's value contains another stored value",
  'basic-invalid': 'a Basic credential that holds a placeholder must be valid base64 of UTF-8',
  'basic-user': "a substituted Basic user can't contain :",
  'header-unsafe': 'a filled-in header would contain CR, LF or NUL',
  'users-off': "kernel users aren't enforced, so seven can't tell which process asks",
  'endpoint-protected':
    'this URL is a model or MCP endpoint, where the vault never fills in a secret',
  'endpoint-model': 'this URL is a model endpoint, where MCP sign-ins never go',
  'mcp-body-framing': 'the MCP request said it has no body but carries one, or the reverse',
  changed:
    "the route, the credential policy or seven's vault changed while the request was prepared; send it again",
};

export const FORWARD_CAUSES = {
  ...VAULT_CAUSES,
  'protocol-version':
    "the kernel asked in a forwarding protocol this seven doesn't speak; update seven",
  'body-framing': 'the kernel framed the request body inconsistently',
  'vault-reply': "seven's vault answered in a form this seven doesn't take; reload seven",
  'vault-error': "seven's vault rejected the forwarding call",
  'vault-refused': "seven's vault refused it without naming why; a newer vault names the reason",
  'vault-unavailable':
    "seven's vault isn't connected or doesn't forward credentials; open the vault window and try again",
  'policy-syncing':
    'seven is still handing its credential policy to the vault; try again in a moment',
  'policy-missing':
    "/etc/fnox/config.toml or /etc/slicc/secrets-policy.toml is missing and seven's vault hasn't paused it, so seven forwards no credential; restore it as a root-owned file",
  'policy-unaccepted':
    "seven's vault hasn't accepted the credential policy in /etc/fnox/config.toml and /etc/slicc/secrets-policy.toml; see the vault window",
  'policy-unavailable': "seven couldn't hand its credential policy to the vault; reload seven",
  'destination-protected':
    "credentials are never filled in for seven's own, loopback, reserved or protected addresses",
  'exit-link':
    'this host goes through a linked device, which carries no credentialed request yet; send this host through this computer under Network',
  'exit-tailnet':
    'this host goes through the tailnet, which carries no credentialed request yet; stop using the exit node, or reach this host off the tailnet',
  'extension-outdated':
    'slicc-extension is older than 7.11.0 and carries no credentialed request; update it',
  'exit-not-credentialed': "this host's network route carries no credentialed request",
  'route-inactive': "this host's network route isn't connected; try again",
  'body-too-large': 'the request body is larger than this route carries',
};

export function vaultCause(cause) {
  return typeof cause === 'string' && Object.hasOwn(VAULT_CAUSES, cause) ? cause : undefined;
}

export function explained(cause, code) {
  const text = FORWARD_CAUSES[cause];
  return cause === 'vault-error' && ERRNO.has(code) ? `${text} (${code})` : text;
}
