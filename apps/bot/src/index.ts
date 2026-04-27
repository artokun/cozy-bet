import { Client, GatewayIntentBits, Events, Partials } from "discord.js";
import { env, allowedGuilds } from "./env.js";
import {
  routeButton,
  routeSelectMenu,
  routeSlash,
} from "./discord/interactions.js";
import {
  commandDefinitions,
  validateCommandDefinitions,
} from "./discord/commands.js";

// Fail fast on duplicate / malformed slash command names so we never push
// a broken catalog up to Discord. Throwing here aborts startup before the
// gateway connects.
validateCommandDefinitions(commandDefinitions);
import { startApi } from "./api.js";
import { startWatchdog } from "./watchdog.js";
import {
  activeArbiterBetsForParticipant,
  recordArbiterEvidence,
} from "./flows.js";

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
    else if (i.isStringSelectMenu()) await routeSelectMenu(i);
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

/** DM listener: captures evidence messages for arbiter cases. Each DM the
 *  bot receives from a user who is a participant in an arbiter-claimed bet
 *  is appended as a bet_event with type='arbiter_evidence' so the arbiter
 *  can review via /arbiter-review. */
client.on(Events.MessageCreate, async (msg) => {
  // Only react to plain user DMs to the bot.
  if (msg.author.bot) return;
  if (msg.guildId) return; // only DMs
  try {
    const bets = await activeArbiterBetsForParticipant(msg.author.id);
    if (bets.length === 0) return;
    // If the user is in multiple arbiter cases, attribute by shortcode mention
    // when we can find one in the message; otherwise fall back to the most
    // recent.
    const matchByCode = (() => {
      for (const b of bets) {
        if (b.shortcode && msg.content.toUpperCase().includes(b.shortcode)) {
          return b;
        }
      }
      return null;
    })();
    const target = matchByCode ?? bets[0]!;
    const attachmentUrls = msg.attachments.map((a) => a.url);
    const result = await recordArbiterEvidence({
      betId: target.id,
      fromDiscordId: msg.author.id,
      text: msg.content,
      attachmentUrls,
    });
    if (!result.ok) {
      if (result.reason === "rate_limit") {
        await msg.reply({
          content: `⚠️ You've already submitted the maximum evidence entries for bet \`${target.shortcode}\` (cap is per-user-per-bet to keep /arbiter-review readable). Send the arbiter a follow-up only if you have something genuinely new.`,
        });
      } else if (result.reason === "empty") {
        await msg.reply({
          content: `⚠️ Empty message — include text or attachments. Bet \`${target.shortcode}\`.`,
        });
      }
      return;
    }
    await msg.reply({
      content: `✅ Recorded ${attachmentUrls.length ? `${attachmentUrls.length} attachment(s) + ` : ""}your evidence for bet \`${target.shortcode}\`. The arbiter will see it.`,
    });
  } catch (e) {
    console.warn("[dm-evidence] failed:", e);
  }
});

await client.login(env.DISCORD_BOT_TOKEN);
const apiServer = startApi(client);
const watchdogTimer = startWatchdog(client);

async function shutdown() {
  console.log("[bot] shutdown");
  clearInterval(watchdogTimer);
  await new Promise<void>((r) => apiServer.close(() => r()));
  await client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
