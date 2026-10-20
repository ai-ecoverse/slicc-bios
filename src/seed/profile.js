import { kernelPortOf, pageLoopback } from './link.js';

export const PROFILE = 'etc/profile';
export const SCRIPT = 'etc/profile.d/slicc.sh';
export const KERNEL_SCRIPT = 'etc/profile.d/slicc-kernel.sh';
export const KERNEL_PORT_KEY = 'slicc-kernel-port';

export const MARK = ': slicc runs /etc/profile.d';

export const LOOP = `${MARK}
for script in /etc/profile.d/*.sh; do
  [ -r "$script" ] && . "$script"
done
unset script
`;

export const PATHS = `gems="$HOME/.local/share/gem/ruby/3.4.0/bin"
case ":$PATH:" in
  *":$gems:"*) ;;
  *) PATH="$gems:$PATH" ;;
esac
unset gems
export PATH
`;

export async function installProfile(root, { text, write }) {
  await write(root, SCRIPT, PATHS);
  const profile = await text(root, PROFILE);
  if (profile === null) return write(root, PROFILE, LOOP);
  if (profile.includes(MARK) || profile.includes('/etc/profile.d/')) return;
  await write(root, PROFILE, `${profile}${profile.endsWith('\n') ? '' : '\n'}${LOOP}`);
}

export function kernelScript(env) {
  return Object.entries(env)
    .map(([name, value]) => `export ${name}='${value}'\n`)
    .join('');
}

export function kernelPorts({ storage, write }) {
  const stored = () => kernelPortOf({ kernel: { port: Number(storage.getItem(KERNEL_PORT_KEY)) } });
  return {
    env: () => pageLoopback(stored()),
    async use(root, peer) {
      const port = kernelPortOf(peer);
      if (port === stored()) return;
      storage.setItem(KERNEL_PORT_KEY, String(port));
      await write(root, KERNEL_SCRIPT, kernelScript(pageLoopback(port)));
    },
  };
}
