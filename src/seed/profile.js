export const PROFILE = 'etc/profile';
export const SCRIPT = 'etc/profile.d/slicc.sh';

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
