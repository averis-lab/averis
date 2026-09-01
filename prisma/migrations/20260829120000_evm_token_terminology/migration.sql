-- Rename the SPL vocabulary the automation layer inherited to EVM terms.
--
-- A "mint" is Solana's word for a token contract. Averis settles on an EVM
-- chain, quotes an eip155 paywall and pays with an ERC-20 transfer, so the
-- word named a thing this system no longer touches — and a field whose name
-- belongs to another chain is how an implementation on that chain quietly
-- looks reasonable to whoever reads it next.
--
-- Nothing here changes a value. The column and the two policy keys carry
-- exactly what they carried before, under the names the rest of the codebase
-- now uses.

-- AlterTable
ALTER TABLE "positions" RENAME COLUMN "mint" TO "token";

-- Stored policies are JSON, and `parseStoredPolicy` fills a missing key from
-- the schema default. Leaving the old keys in place would therefore not fail:
-- it would silently reset an owner's configured cooldown to 60 minutes and
-- empty their blocklist, which is the failure mode that loses money quietly.
-- So the keys are renamed in place, and only where they are actually present.
-- `jsonb_exists` rather than the `?` operator: `?` is a parameter placeholder to
-- enough tooling that writing it into a migration is a needless bet.
UPDATE "automations"
SET "policy" = ("policy" - 'mintCooldownMinutes')
    || jsonb_build_object('tokenCooldownMinutes', "policy" -> 'mintCooldownMinutes')
WHERE jsonb_exists("policy", 'mintCooldownMinutes');

UPDATE "automations"
SET "policy" = ("policy" - 'blockedMints')
    || jsonb_build_object('blockedTokens', "policy" -> 'blockedMints')
WHERE jsonb_exists("policy", 'blockedMints');
