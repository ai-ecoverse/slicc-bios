export const MIN_EXTENSION_VERSION = '7.10.0';
export const EXTENSION_UPDATE =
  'slicc: refused: Update slicc-extension to use browser automation in seven. Reload this tab after updating.';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MINIMUM = MIN_EXTENSION_VERSION.split('.').map(BigInt);

export function extensionAutomationSupported(extension = globalThis.sliccExtension) {
  let version;
  try {
    version = extension?.version;
  } catch {
    return false;
  }
  if (typeof version !== 'string' || !RELEASE.test(version)) return false;
  const actual = version.split('.').map(BigInt);
  for (let index = 0; index < MINIMUM.length; index += 1) {
    if (actual[index] !== MINIMUM[index]) return actual[index] > MINIMUM[index];
  }
  return true;
}
