/** The automatic handoff, split by moment: request (turn end, prompt, brake), start, failure, fresh start, merge. */
export { onStopFailure } from "./failure";
export { freshStart } from "./fresh";
export { freshPending, setFresh, takeFresh } from "./marks";
export { mergeNow } from "./merge";
export { readHandoff } from "./read";
export { awaitingStart, FILE, readRegistry, rootOf, successors } from "./registry";
export { checkpoint, noteWritten, notStarted, onPrompt, onStop, requestNow, takeOpen } from "./request";
export { DEFAULTS, readConfig } from "./settings";
export { onSessionStart } from "./start";
export { goalOf, instruction } from "./text";
export { readUsage } from "./usage";
