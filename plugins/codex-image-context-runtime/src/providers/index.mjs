import { createMockProvider } from "./mock.mjs";
import { createOpenAIProvider } from "./openai.mjs";

export function createProvider(config, options = {}) {
  return config.provider.mode === "openai"
    ? createOpenAIProvider({
        ...options.openai,
        generationModel: config.provider.generation_model,
        visionModel: config.provider.vision_model
      })
    : createMockProvider(options.mock);
}
