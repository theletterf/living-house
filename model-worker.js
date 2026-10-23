// Inference runs in this browser worker. Prompts and events stay on this device.
// The runtime and model files are downloads, as in the main-thread version.
import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm@0.2.85";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event) => handler.onmessage(event);
