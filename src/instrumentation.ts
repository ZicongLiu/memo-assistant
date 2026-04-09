export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDiscordBot } = await import("./lib/discord-bot");
    startDiscordBot();
  }
}
