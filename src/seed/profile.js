export const PROFILE = 'etc/profile';
export const SCRIPT = 'etc/profile.d/slicc.sh';

export const LOOP = `for script in /etc/profile.d/*.sh; do
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
  if ((await text(root, PROFILE)) === null) await write(root, PROFILE, LOOP);
}
