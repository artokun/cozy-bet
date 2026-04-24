import { REST, Routes } from "discord.js";
import { env } from "../env.js";
import { commandDefinitions } from "../discord/commands.js";

const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);

if (env.DISCORD_TEST_GUILD_ID) {
  await rest.put(
    Routes.applicationGuildCommands(
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_TEST_GUILD_ID,
    ),
    { body: commandDefinitions },
  );
  console.log(
    `registered ${commandDefinitions.length} guild commands on ${env.DISCORD_TEST_GUILD_ID}`,
  );
} else {
  await rest.put(Routes.applicationCommands(env.DISCORD_APPLICATION_ID), {
    body: commandDefinitions,
  });
  console.log(
    `registered ${commandDefinitions.length} global commands (may take up to 1h to propagate)`,
  );
}
