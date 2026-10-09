export async function answer(kernel, { port, path, method, headers, body }, reply) {
  try {
    const request = new Request(`http://${port}.kernel.localhost${path}`, {
      method,
      headers,
      body,
    });
    const response = await kernel.loopbackFetch(request, { port });
    const stream = response.body;
    reply.postMessage(
      {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body: stream,
      },
      stream ? [stream] : []
    );
  } catch (error) {
    reply.postMessage({ error: error.message, code: error.code });
  }
}

export function serveLoopback(kernel, container = navigator.serviceWorker) {
  container?.addEventListener('message', ({ data, ports: [reply] }) => {
    if (data?.loopback && reply) void answer(kernel, data.loopback, reply);
  });
  container?.startMessages();
}
