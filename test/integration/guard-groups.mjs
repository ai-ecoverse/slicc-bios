import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };

export const ALL_TARGETS = [...new Set(set.vectors.flatMap((vector) => vector.targets))];
export const GROUPS = {
  seven: ['seven'],
  vault: ['vault'],
  'vault-x': ['vault-x'],
  apex: ['apex'],
};
const named = new Set(Object.values(GROUPS).flat());

export const groupTargets = (group) =>
  group === 'rest' ? ALL_TARGETS.filter((target) => !named.has(target)) : GROUPS[group];
