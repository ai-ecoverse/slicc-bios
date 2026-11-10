export const OAUTH_MS = 44000;
export const CAPABILITIES_MS = 10000;
const OPS = new Set(['capabilities', 'oauthGrant', 'oauthStatus', 'oauthRefresh', 'oauthRemove']);
const MUTATIONS = new Set(['oauthGrant', 'oauthRefresh', 'oauthRemove']);
const STATES = new Set(['ready', 'refreshing', 'expired', 'reauth-required', 'removed', 'locked']);
const CODES = {
  EINVAL: 'Invalid OAuth request',
  ENOENT: 'OAuth record not found',
  EEXIST: 'OAuth record cannot be replaced',
  EACCES: 'OAuth request refused',
  EAGAIN: 'OAuth record changed; try again',
  ENOTSUP: 'Kernel OAuth is not supported',
  ENOTCONN: 'Vault is unavailable',
  ETIMEDOUT: 'OAuth request timed out',
  EIO: 'Invalid vault OAuth response',
};
const CAUSES = {
  'vault-locked': 'Vault is locked',
  'oauth-reauth-required': 'OAuth sign-in is required',
  'oauth-refresh-failed': 'OAuth refresh failed',
};
const PLACEHOLDER = /^fnox_proxy_[0-9a-f]{24}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const placeholder = (value) => typeof value === 'string' && PLACEHOLDER.test(value);

export const kernelOAuthOp = (op) => OPS.has(op);

export function oauthError(code = 'EIO', cause) {
  if (!Object.hasOwn(CODES, code) || (cause !== undefined && !Object.hasOwn(CAUSES, cause)))
    return oauthError();
  return {
    v: 1,
    error: {
      code,
      ...(cause === undefined ? {} : { cause }),
      message: cause === undefined ? CODES[code] : CAUSES[cause],
    },
  };
}

function errorReply(reply) {
  if (
    !exact(reply, ['v', 'error']) ||
    reply.v !== 1 ||
    !exact(reply.error, ['code', 'message'], ['cause']) ||
    typeof reply.error.message !== 'string' ||
    reply.error.message.length > 65536
  )
    return oauthError();
  return oauthError(reply.error.code, reply.error.cause);
}

export function oauthReply(op, reply) {
  if (!object(reply) || reply.v !== 1) return oauthError();
  if (Object.hasOwn(reply, 'error')) return errorReply(reply);
  if (op === 'capabilities') {
    if (
      !exact(reply, ['v', 'capabilities']) ||
      !exact(reply.capabilities, [], ['kernelOAuth']) ||
      (Object.hasOwn(reply.capabilities, 'kernelOAuth') && reply.capabilities.kernelOAuth !== 1)
    )
      return oauthError();
    return { v: 1, capabilities: { ...reply.capabilities } };
  }
  if (op === 'oauthRemove')
    return exact(reply, ['v', 'removed']) && reply.removed === true
      ? { v: 1, removed: true }
      : oauthError();
  if (
    !exact(reply, ['v', 'placeholder', 'state', 'expiresAt', 'refreshable']) ||
    !placeholder(reply.placeholder) ||
    !STATES.has(reply.state) ||
    (reply.expiresAt !== null && !integer(reply.expiresAt)) ||
    typeof reply.refreshable !== 'boolean'
  )
    return oauthError();
  return {
    v: 1,
    placeholder: reply.placeholder,
    state: reply.state,
    expiresAt: reply.expiresAt,
    refreshable: reply.refreshable,
  };
}

function envelope(reply, op, fields) {
  if (!object(reply) || reply.v !== 1 || !integer(reply.id)) return oauthError();
  if (Object.hasOwn(reply, 'error')) {
    if (!exact(reply, ['v', 'id', 'error'])) return oauthError();
    return errorReply({ v: reply.v, error: reply.error });
  }
  return exact(reply, ['v', 'id', 'op', ...fields]) && reply.op === op ? reply : oauthError();
}

function supported(reply) {
  const outer = envelope(reply, 'status', ['status']);
  if (outer.error) return outer;
  const status = outer.status;
  if (
    !object(status) ||
    status.protocol !== 1 ||
    typeof status.version !== 'string' ||
    !status.version ||
    !object(status.capabilities) ||
    typeof status.locked !== 'boolean'
  )
    return oauthError();
  return status.capabilities.kernelOAuth === 1;
}

export function oauthScrub(reply) {
  const outer = envelope(reply, 'placeholders', ['placeholders', 'scrub']);
  if (outer.error) return outer;
  if (
    !Array.isArray(outer.placeholders) ||
    !outer.placeholders.every(placeholder) ||
    !exact(outer.scrub, ['needed', 'version', 'ready']) ||
    typeof outer.scrub.needed !== 'boolean' ||
    !integer(outer.scrub.version) ||
    typeof outer.scrub.ready !== 'boolean'
  )
    return oauthError('ENOTCONN');
  return { placeholders: [...outer.placeholders], scrub: { ...outer.scrub } };
}

function unsupported(op, support) {
  if (support !== false) return support;
  return op === 'capabilities' ? { v: 1, capabilities: {} } : oauthError('ENOTSUP');
}

function relayFailure(error, stop, deadline) {
  if (stop.aborted) return oauthError(deadline.aborted ? 'ETIMEDOUT' : 'ENOTCONN');
  return oauthError(error?.code, error?.cause);
}

async function synchronize(call, options, barrier, current, ready) {
  try {
    const fresh = oauthScrub(await call('placeholders', {}, options));
    current();
    if (fresh.error || (ready && !fresh.scrub.ready))
      throw Object.assign(new Error(), { code: 'ENOTCONN' });
    await barrier(fresh, { signal: options.signal });
    current();
  } catch (error) {
    current();
    throw Object.assign(new Error(), {
      code: error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ENOTCONN',
    });
  }
}

export function oauthRelay({
  call,
  barrier,
  generation = () => 0,
  timeout = (ms) => AbortSignal.timeout(ms),
}) {
  return async (req, caller, signal) => {
    const deadline = timeout(req.op === 'capabilities' ? CAPABILITIES_MS : OAUTH_MS);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const options = { signal: stop, dropAway: true, raw: true };
    const epoch = generation();
    const current = () => {
      stop.throwIfAborted();
      if (epoch !== generation()) throw Object.assign(new Error(), { code: 'ENOTCONN' });
    };
    try {
      current();
      const support = supported(await call('status', {}, options));
      current();
      if (support !== true) return unsupported(req.op, support);
      if (req.op === 'capabilities' || req.op === 'oauthGrant')
        await synchronize(call, options, barrier, current, false);
      const outer = envelope(
        await call('sealed', { req, stamp: caller, kernelOAuth: 1 }, options),
        'sealed',
        ['reply']
      );
      current();
      const reply = outer.error ? outer : oauthReply(req.op, outer.reply);
      if (!reply.error && MUTATIONS.has(req.op))
        await synchronize(call, options, barrier, current, req.op !== 'oauthRemove');
      return reply;
    } catch (error) {
      return relayFailure(error, stop, deadline);
    }
  };
}
