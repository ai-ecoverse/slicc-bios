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

export function clipboardWrite(
  board = () => navigator.clipboard,
  Item = (items) => new ClipboardItem(items)
) {
  return async ({ options, body }) => {
    const type = options?.type ?? 'image/png';
    if (!TYPES.includes(type)) {
      await body?.cancel?.();
      throw new DOMException(`seven doesn't copy ${String(type)}`, 'NotSupportedError');
    }
    const blob = new Blob([await new Response(body).arrayBuffer()], { type });
    try {
      await board().write([Item({ [type]: blob })]);
    } catch (error) {
      refused(error);
    }
  };
}
