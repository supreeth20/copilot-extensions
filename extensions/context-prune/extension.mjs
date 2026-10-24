import { joinSession } from "@github/copilot-sdk/extension";
import { createContextPrune } from "./runtime.mjs";

let session;
session = await joinSession(createContextPrune(() => session));
