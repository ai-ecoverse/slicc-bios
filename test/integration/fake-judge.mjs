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

const INTENT_READ = {
  wants_read: bool(0.94),
  wants_write: bool(0.02),
  wants_delete: bool(0.01),
  wants_permissions: bool(0.01),
  wants_code: bool(0.02),
  wants_send: bool(0.01),
  wants_secrets: bool(0.01),
  wants_services: bool(0.01),
};

let forcedForbidden = null;

export function forceForbidden(probability) {
  forcedForbidden = probability;
}

export function clearForcedForbidden() {
  forcedForbidden = null;
}

const ROUTINE = [
  {
    match: /(?:^|[\s/])jq \.rules \/etc\/slicc\/secrets-policy\.toml$/,
    always: 0.02,
  },
  { match: /(?:^|[\s/])id -gn$/, always: 0.9 },
  { match: /(?:^|[\s/])id -Gn$/, always: 0.02 },
  { match: /(?:^|[\s/])id -u$/, always: 0.02 },
  { match: /(?:^|[\s/])printf /, always: 0.02 },
  { match: /(?:^|[\s/])ls -la \/(?:etc|root)$/, always: 0.02 },
];

const DANGER = [
  { match: /(?:^|[\s/;|&])(?:rm|rmdir|unlink)\b/, kind: 'delete' },
  {
    match: /(?:^|[\s/;|&])(?:chmod|chown|chgrp|setfacl)\b|\/etc\/sudoers|\bsudoers\b/,
    kind: 'permissions',
  },
  {
    match:
      /(?:^|[\s/;|&])(?:python3?|node|nodejs|ruby|perl|php|lua)\b|(?:^|[\s/;|&])(?:ba)?sh\s+-c\b|-\w*c\s+['"`]/,
    kind: 'code',
  },
  {
    match:
      /\.ssh\b|\/etc\/shadow\b|\bid_rsa\b|\.netrc\b|\.npmrc\b|\/proc\/\S*\/environ\b|(?:^|[\s/;|&])(?:printenv|env)\b/,
    kind: 'secrets',
  },
  {
    match:
      /(?:^|[\s/;|&])(?:kill|pkill|killall|reboot|shutdown|halt|poweroff|mount|umount)\b|(?:^|[\s/;|&])systemctl\b[\s\S]*\brestart\b|(?:^|[\s/;|&])service\s+\S+\s+restart\b/,
    kind: 'services',
  },
  {
    match:
      /(?:^|[\s/;|&])(?:scp|rsync|mail|mailx)\b|(?:^|[\s/;|&])curl\b[\s\S]*\s-[A-Za-z]*d\b|(?:^|[\s/;|&])wget\b[\s\S]*--post/,
    kind: 'send',
  },
];

const KIND_RANK = {
  services: 6,
  delete: 5,
  permissions: 4,
  secrets: 3,
  code: 2,
  send: 1,
  unknown: 0,
  routine: -1,
};

const commandOf = (untrusted) => {
  const text = String(untrusted ?? '');
  const opened = text.match(/<untrusted-[^>]+>\n?/);
  if (!opened) return text.split('\n')[0] ?? '';
  return text.slice(opened.index + opened[0].length).split('\n')[0] ?? '';
};

const segmentsOf = (command) => {
  const parts = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '`') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      i += 1;
      while (i < command.length && command[i] !== '`') i += 1;
      parts.push('`code`');
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      let depth = 1;
      i += 2;
      while (i < command.length && depth) {
        if (command[i] === '(') depth += 1;
        else if (command[i] === ')') depth -= 1;
        i += 1;
      }
      i -= 1;
      parts.push('$(code)');
      continue;
    }
    if (c === ';' || c === '|') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if (c === '|' && command[i + 1] === '|') i += 1;
      continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [command];
};

const kindOfPart = (part) => {
  for (const entry of ROUTINE)
    if (entry.match.test(part)) return { kind: 'routine', always: entry.always };
  for (const entry of DANGER) if (entry.match.test(part)) return { kind: entry.kind };
  return { kind: 'unknown' };
};

export function classifyCommand(command) {
  const parts = segmentsOf(String(command ?? '').trim());
  let best = { kind: 'routine', always: 0.02, rank: KIND_RANK.routine };
  for (const part of parts) {
    const got = kindOfPart(part);
    const rank = KIND_RANK[got.kind] ?? 0;
    if (rank > best.rank) best = { ...got, rank };
    else if (rank === best.rank && got.kind === 'routine' && best.kind === 'routine') {
      best = { ...got, rank, always: Math.max(best.always ?? 0, got.always ?? 0) };
    }
  }
  if (best.kind === 'routine' && parts.some((part) => kindOfPart(part).kind === 'unknown')) {
    return { kind: 'unknown' };
  }
  if (best.kind === 'routine') return { kind: 'routine', always: best.always ?? 0.02 };
  return { kind: best.kind };
}

const vectorOf = (classified) => {
  if (classified.kind === 'routine') {
    return {
      changes: 0.03,
      others: 0,
      system: 0,
      delete: 0,
      permissions: 0,
      code: 0.04,
      services: 0,
      send: 0,
      secrets: 0.05,
      plain: 0.85,
      always: forcedForbidden === null ? classified.always : 0.9,
    };
  }
  const base = {
    changes: 0,
    others: 0,
    system: 0,
    delete: 0,
    permissions: 0,
    code: 0,
    services: 0,
    send: 0,
    secrets: 0,
    plain: 0.1,
    always: 0.9,
  };
  if (classified.kind === 'unknown') return { ...base, plain: 0 };
  if (classified.kind === 'delete') return { ...base, delete: 0.91, changes: 0.85 };
  if (classified.kind === 'permissions') return { ...base, permissions: 0.91, changes: 0.7 };
  if (classified.kind === 'code') return { ...base, code: 0.91 };
  if (classified.kind === 'secrets') return { ...base, secrets: 0.91 };
  if (classified.kind === 'services')
    return { ...base, services: 0.91, changes: 0.72, system: 0.31 };
  if (classified.kind === 'send') return { ...base, send: 0.91 };
  return { ...base, plain: 0 };
};

const actionsOf = (untrusted) => {
  const classified = classifyCommand(commandOf(untrusted));
  return Object.fromEntries(
    Object.entries(vectorOf(classified)).map(([id, probability]) => [id, bool(probability)])
  );
};

const forbidOf = () => bool(forcedForbidden === null ? 0.04 : forcedForbidden);

const poolOf = (input) => {
  const ids = new Set(Object.keys(input.questions ?? {}));
  const pool = {};
  if (ids.has('level') || ids.has('aligned')) Object.assign(pool, GUEST);
  if ([...ids].some((id) => id.startsWith('wants_'))) Object.assign(pool, INTENT_READ);
  if (ids.has('forbidden')) pool.forbidden = forbidOf();
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
