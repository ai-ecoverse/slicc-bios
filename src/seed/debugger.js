export const DEBUGGER_ROUTE_UPDATE =
  'slicc: refused: Update the selected browser route to use Debugger in seven: slicc-extension 7.11.1 or slicc 1.49.37 or later. Reload seven after updating.';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const floors = { extension: [7n, 11n, 1n], link: [1n, 49n, 37n] };
const lifetimes = new Map([
  ['Debugger.enable', 'persistent'],
  ['Debugger.setInstrumentationBreakpoint', 'persistent'],
  ['Debugger.disable', 'cleanup'],
  ['Debugger.removeBreakpoint', 'cleanup'],
  ['Debugger.resume', 'control'],
  ['Debugger.pause', 'control'],
  ['Debugger.getScriptSource', 'document'],
  ['Debugger.evaluateOnCallFrame', 'document'],
]);

export const debuggerLifetime = (method) => lifetimes.get(method);
export const debuggerAdmitted = (method) =>
  ['persistent', 'cleanup'].includes(debuggerLifetime(method)) || method === 'Debugger.resume';

export function debuggerRouteSupported(route) {
  const floor = floors[route?.kind];
  const version = route?.version;
  if (!floor || typeof version !== 'string' || !RELEASE.test(version)) return false;
  const actual = version.split('.').map(BigInt);
  const at = actual.findIndex((part, i) => part !== floor[i]);
  return at < 0 || actual[at] > floor[at];
}
