import { Client, GatewayIntentBits, Events, Partials } from "discord.js";
import { env, allowedGuilds } from "./env.js";
import { routeButton, routeSlash } from "./discord/interactions.js";
import { startApi } from "./api.js";
import { startWatchdog } from "./watchdog.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // needed for DMs
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  const guilds = allowedGuilds();
  if (i.inGuild() && guilds && !guilds.has(i.guildId!)) {
    if (i.isRepliable()) {
      await i.reply({
        content: "This bot is restricted to specific servers.",
        ephemeral: true,
      });
    }
    return;
  }
  // No dispatcher-level mutex: handlers are responsible for acknowledging
  // (reply / deferReply / deferUpdate) within Discord's 3s window. Handlers
  // that mutate state should wrap their critical section with
  // `serializeForUser(i.user.id, ...)` from `util/userMutex.js` to prevent
  // same-user races. See e.g. handleAccept in discord/commands.ts.
  try {
    if (i.isChatInputCommand()) await routeSlash(i);
    else if (i.isButton()) await routeButton(i);
  } catch (e: any) {
    console.error("[interaction] error", e);
    try {
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i.reply({
          content: `Error: ${e?.message ?? e}`,
          ephemeral: true,
        });
      } else if (i.isRepliable() && i.deferred) {
        await i.editReply({ content: `Error: ${e?.message ?? e}` });
      }
    } catch {}
  }
});

await client.login(env.DISCORD_BOT_TOKEN);
const apiServer = startApi(client);
const watchdogTimer = startWatchdog(client);

async function shutdown() {
  console.log("[bot] shutdown");
  if (watchdogTimer) clearInterval(watchdogTimer);
  await new Promise<void>((r) => apiServer.close(() => r()));
  await client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
