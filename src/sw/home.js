export async function returnHome({
  win = window,
  doc = document,
  storage = navigator.storage,
} = {}) {
  if (win.location.hostname !== 'seven.sliccy.ai' || win.top !== win) return false;
  const url = new URL(win.location.href);
  if (url.searchParams.has('stay')) {
    doc.cookie = 'slicc-home=; Domain=sliccy.ai; Path=/; Secure; SameSite=Lax; Max-Age=0';
    url.searchParams.delete('stay');
    win.history.replaceState(win.history.state, '', url.href);
    return false;
  }
  if (!doc.cookie.split(';').some((part) => part.trim() === 'slicc-home=www')) return false;
  try {
    const root = await storage.getDirectory();
    await root.getDirectoryHandle('os');
    return false;
  } catch (error) {
    if (error.name !== 'NotFoundError') return false;
  }
  win.location.replace('https://www.sliccy.ai/7/' + win.location.hash);
  return true;
}
