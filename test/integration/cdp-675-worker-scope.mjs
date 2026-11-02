export async function workerScopeRead(read, row, now = Date.now) {
  const deadline = Math.min(now() + 3000, row.pause.at + 5000);
  row.workerScopeDeadline = deadline;
  row.workerScopeAttempts = [];
  for (let attempt = 0; attempt < 3 && now() < deadline; attempt += 1) {
    const started = now();
    const milliseconds = Math.min(1000, deadline - started);
    const record = { started, milliseconds };
    row.workerScopeAttempts.push(record);
    try {
      const reply = await read(milliseconds);
      record.ended = now();
      record.reply = reply;
      return reply;
    } catch (error) {
      record.ended = now();
      record.error = error.message;
      if (error.message !== `raw Runtime.evaluate exceeded ${milliseconds}ms`) throw error;
    }
  }
  throw new Error('owned worker scope read exhausted its bounded retries before kill');
}
