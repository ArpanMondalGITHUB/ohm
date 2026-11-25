/**
 * Turns a streaming HTTP body into the text after each "data:" line.
 * Handles chunks that cut a line in half by keeping a buffer.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // the last piece may be incomplete, so keep it for later

    for (const line of lines) {
      const data = dataOf(line);
      if (data !== undefined) yield data;
    }
  }

  const data = dataOf(buffer); // anything left when the stream closed
  if (data !== undefined) yield data;
}

function dataOf(line: string): string | undefined {
  const clean = line.replace(/\r$/, "");          // Windows-style line endings
  if (!clean.startsWith("data:")) return undefined; // skips blank lines and ": comments"
  return clean.slice(5).trimStart();
}
