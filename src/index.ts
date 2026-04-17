import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { send } from "./commands/send";
import { preflight } from "./commands/preflight";
import { newCmd } from "./commands/new";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--stop-all") {
  await stopAll();
} else if (command === "--stop") {
  await stop();
} else if (command === "--clear") {
  await clear();
} else if (command === "start") {
  await start(args.slice(1));
} else if (command === "status") {
  await status(args.slice(1));
} else if (command === "telegram") {
  await telegram();
} else if (command === "discord") {
  await discord();
} else if (command === "send") {
  await send(args.slice(1));
} else if (command === "preflight") {
  preflight(args.slice(1));
} else if (command === "new") {
  await newCmd(args.slice(1));
} else {
  await start();
}
