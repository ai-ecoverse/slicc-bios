export const REFUSED =
  "The clipboard needs seven's tab to be in front, and clipboard access allowed";

function refused(error) {
  if (error?.name !== 'NotAllowedError') throw error;
  throw new DOMException(REFUSED, 'NotAllowedError');
}

export function clipboardHook(board = () => navigator.clipboard) {
  return {
    read: async () => {
      try {
        return await board().readText();
      } catch (error) {
        return refused(error);
      }
    },
    write: async (text) => {
      try {
        await board().writeText(text);
      } catch (error) {
        refused(error);
      }
    },
  };
}

export const TYPES = ['image/png', 'text/plain', 'text/html'];
export const CAP = 16 * 1024 * 1024;
export const TOO_BIG = 'seven copies at most 16 MB to the clipboard';

export async function bounded(body, cap = CAP) {
  const parts = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel(TOO_BIG).catch(() => undefined);
      throw new RangeError(TOO_BIG);
    }
    parts.push(value);
  }
}

export function clipboardWrite(
  board = () => navigator.clipboard,
  Item = (items) => new ClipboardItem(items),
  cap = CAP
) {
  return async ({ options, body }) => {
    const type = options?.type ?? 'image/png';
    if (!TYPES.includes(type)) {
      await body?.cancel?.();
      throw new DOMException(`seven doesn't copy ${String(type)}`, 'NotSupportedError');
    }
    const blob = new Blob(await bounded(body, cap), { type });
    try {
      await board().write([Item({ [type]: blob })]);
    } catch (error) {
      refused(error);
    }
  };
}
