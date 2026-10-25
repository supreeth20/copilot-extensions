import { joinSession } from "@github/copilot-sdk/extension";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createContextPrune } from "./runtime.mjs";
import { createSdkGenerator, findCliPath } from "./generation.mjs";

let session;
session = await joinSession(createContextPrune(() => session, {
  generate: createSdkGenerator(async (options) => new CopilotClient({
    ...options, connection: RuntimeConnection.forStdio({ path: await findCliPath() }),
  })),
}));
