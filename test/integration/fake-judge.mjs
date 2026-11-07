const bool = (probability) => ({ type: 'noul', noul: probability });

const GUEST = {
  level: {
    type: 'choice',
    choice: 'routine',
    probabilities: { routine: 0.97, permissions: 0.02, harm: 0.01 },
    confidence: 0.97,
  },
  aligned: bool(0.95),
};

const INTENT = {
  wants_read: bool(0.94),
  wants_write: bool(0.02),
  wants_delete: bool(0.01),
  wants_permissions: bool(0.01),
  wants_code: bool(0.02),
  wants_send: bool(0.01),
  wants_secrets: bool(0.01),
  wants_services: bool(0.01),
};

const FORBID = { forbidden: bool(0.04) };

const SERVICES =
  /(?:^|[\s/;|&])(?:kill|pkill|killall|reboot|shutdown|halt|poweroff|mount|umount|systemctl\s+restart|service\s+\S+\s+restart)\b/;

const commandOf = (untrusted) => {
  const text = String(untrusted ?? '');
  const opened = text.match(/<untrusted-[^>]+>\n?/);
  if (!opened) return text.split('\n')[0] ?? '';
  return text.slice(opened.index + opened[0].length).split('\n')[0] ?? '';
};

const actionsOf = (untrusted) => {
  const command = commandOf(untrusted);
  const replay = /\/id -gn\n/.test(String(untrusted ?? '')) ? 0.9 : 0.02;
  if (SERVICES.test(command)) {
    return {
      changes: bool(0.72),
      others: bool(0),
      system: bool(0.31),
      delete: bool(0),
      permissions: bool(0),
      code: bool(0.04),
      services: bool(0.91),
      send: bool(0),
      secrets: bool(0.05),
      plain: bool(0.85),
      always: bool(0.9),
    };
  }
  return {
    changes: bool(0.03),
    others: bool(0),
    system: bool(0),
    delete: bool(0),
    permissions: bool(0),
    code: bool(0.04),
    services: bool(0),
    send: bool(0),
    secrets: bool(0.05),
    plain: bool(0.85),
    always: bool(replay),
  };
};

const poolOf = (input) => {
  const ids = new Set(Object.keys(input.questions ?? {}));
  const pool = {};
  if (ids.has('level') || ids.has('aligned')) Object.assign(pool, GUEST);
  if ([...ids].some((id) => id.startsWith('wants_'))) Object.assign(pool, INTENT);
  if (ids.has('forbidden')) Object.assign(pool, FORBID);
  if (ids.has('changes') || ids.has('plain') || ids.has('always')) {
    Object.assign(pool, actionsOf(input.state?.request?.untrusted));
  }
  return pool;
};

export function judgeAnswers(body, log) {
  const { input } = JSON.parse(body.toString());
  log?.(input);
  const asked = Object.keys(input.questions ?? {});
  const pool = poolOf(input);
  const missing = asked.filter((id) => pool[id] === undefined);
  if (missing.length) {
    throw new Error(`fake judge has no answer for ${missing.join(', ')}`);
  }
  return {
    success: true,
    result: { answers: Object.fromEntries(asked.map((id) => [id, pool[id]])) },
  };
}
