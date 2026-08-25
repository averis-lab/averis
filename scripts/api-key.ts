import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import { generateApiKey, hashApiKey, maskApiKey } from "../apps/api/src/api-key";

/**
 * Mints and lists account API keys.
 *
 * The raw key is printed once and never stored — only its SHA-256 digest
 * reaches the database — so "lost it" and "rotate it" are the same operation.
 *
 *   npm run key:create -- --handle alice [--email alice@example.com]
 *   npm run key:create -- --list
 */

interface Args {
  handle?: string;
  email?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--list") args.list = true;
    else if (flag === "--handle") args.handle = argv[++i];
    else if (flag === "--email") args.email = argv[++i];
  }
  return args;
}

async function list(): Promise<void> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      handle: true,
      email: true,
      apiKeyHash: true,
      createdAt: true,
      _count: { select: { jobs: true, agents: true } },
    },
  });

  if (users.length === 0) {
    console.log("No accounts yet. Create one with: npm run key:create -- --handle <name>");
    return;
  }

  console.log(`${users.length} account(s):\n`);
  for (const user of users) {
    console.log(
      `  ${(user.handle ?? user.email ?? user.id).padEnd(20)} ` +
        `${user.apiKeyHash ? "key set" : "no key "}  ` +
        `${String(user._count.jobs).padStart(4)} jobs  ` +
        `${String(user._count.agents).padStart(3)} agents  ${user.id}`,
    );
  }
}

async function mint(handle: string, email?: string): Promise<void> {
  const key = generateApiKey();
  const apiKeyHash = hashApiKey(key);

  const existing = await prisma.user.findUnique({ where: { handle } });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { apiKeyHash, ...(email ? { email } : {}) },
      })
    : await prisma.user.create({ data: { handle, email, apiKeyHash } });

  console.log(existing ? `\nRotated the key for "${handle}".` : `\nCreated account "${handle}".`);
  if (existing) console.log("The previous key stops working within the auth cache TTL (30s).");
  console.log(`\n  account   ${user.id}`);
  console.log(`  key       ${key}`);
  console.log(`  fingerprint ${maskApiKey(key)}\n`);
  console.log("This is the only time the key is shown — it is stored hashed.\n");
  console.log(`  curl -H "Authorization: Bearer ${key}" http://localhost:4000/v1/jobs\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) return list();

  if (!args.handle) {
    console.error("Usage: npm run key:create -- --handle <name> [--email <email>]");
    console.error("       npm run key:create -- --list");
    process.exitCode = 1;
    return;
  }

  await mint(args.handle, args.email);
}

main()
  .catch((error: unknown) => {
    console.error("failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
