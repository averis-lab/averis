-- Settlement moves from Solana to an EVM chain (Robinhood Chain).
--
-- Only the default changes. Existing rows keep the chain they actually settled
-- on: rewriting history to say a past transaction happened somewhere it did not
-- would destroy the one thing this column is for.

ALTER TABLE "transactions" ALTER COLUMN "chain" SET DEFAULT 'robinhood';
