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
