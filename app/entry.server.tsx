import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

/**
 * Only used at build time: in SPA mode React Router renders the shell once into build/client/index.html. The
 * running dashboard never executes this file; the Fleet server serves the static result.
 */
export default function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
  return new Promise<Response>((resolve, reject) => {
    const { pipe } = renderToPipeableStream(<ServerRouter context={context} url={request.url} />, {
      onAllReady() {
        const body = new PassThrough();
        headers.set("Content-Type", "text/html");
        resolve(new Response(createReadableStreamFromReadable(body), { headers, status }));
        pipe(body);
      },
      onShellError: reject,
    });
  });
}
