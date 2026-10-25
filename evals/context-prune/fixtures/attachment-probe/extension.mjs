import { joinSession } from "@github/copilot-sdk/extension";

let session;
session = await joinSession({
  commands: [{
    name: "attachment-probe-push",
    description: "Disposable evaluation: recover an image from this test journal into the composer.",
    handler: async () => {
      const events = await session.getEvents();
      const original = events.find((event) => event.type === "user.message" &&
        event.data.attachments?.some((attachment) => ["blob", "file"].includes(attachment.type)));
      const attachment = original?.data.attachments.find((attachment) => ["blob", "file"].includes(attachment.type));
      const asset = events.find((event) => event.type === "session.binary_asset" &&
        event.data.assetId === attachment?.assetId);
      const data = attachment?.data ?? asset?.data.data;
      if (typeof data !== "string") throw new Error("Original test attachment bytes are unavailable");
      await session.rpc.extensions.sendAttachmentsToMessage({
        attachments: [{ type: "blob", displayName: attachment.displayName, mimeType: attachment.mimeType ?? asset?.data.mimeType, data }],
      });
    },
  }],
});
