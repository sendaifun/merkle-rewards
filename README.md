# SendAI Merkle Rewards

A Solana program for SendAI's weekly SPL-token reward claims.

Each week is an independent, immutable Merkle distribution. SendAI computes user allocations off-chain, publishes one Merkle root on-chain, funds the distribution vault, and serves each eligible wallet its allocation and proof. Users claim directly to their token accounts. Once the claim window ends, the authority closes the distribution and returns unclaimed tokens to the treasury.

## Program ID

```text
T4RpCJXznFSw9atB4mmmDbZjUeDrxXDMUjV3qxEsuzi
```

The program is deployed on devnet. Mainnet deployment is pending.

| Network | Program ID                                                                                                                                      | Status                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Devnet  | [`T4RpCJXznFSw9atB4mmmDbZjUeDrxXDMUjV3qxEsuzi`](https://explorer.solana.com/address/T4RpCJXznFSw9atB4mmmDbZjUeDrxXDMUjV3qxEsuzi?cluster=devnet) | Deployed (2026-07-17) |
| Mainnet | `T4RpCJXznFSw9atB4mmmDbZjUeDrxXDMUjV3qxEsuzi`                                                                                                   | Pending               |

The deployed devnet binary matches the local build byte-for-byte with SHA-256 `f1854600c3d91bd42cf5c69f808846fd807402711b2e7dc249b6ab130518d07d`.

## Weekly lifecycle

1. Finalize the week's wallet allocations in base units.
2. Create an `Immediate` vesting leaf for every `(wallet, totalAmount)` allocation.
3. Build the Merkle tree and persist the root, complete allocation file, and proofs.
4. Create a new `MerkleDistribution` with a unique seed, the root, the total allocation, and a future `clawbackTs`.
5. Fund its vault with enough reward tokens to cover every leaf.
6. Return the distribution address, allocation, schedule, and proof from the claim backend.
7. The user signs `ClaimMerkle`; the program verifies the proof and transfers the available tokens.
8. After `clawbackTs`, close the distribution. All unclaimed tokens return to the authority's token account and the vault rent returns to the authority.
9. Reuse those recovered treasury tokens when funding the following week's distribution.

The Merkle root cannot be updated. Corrections therefore require a new distribution, and every week must use a unique seed. A distribution PDA cannot be recreated after it has been closed.

## On-chain instructions used

| Instruction                | Signer    | Purpose                                                                 |
| -------------------------- | --------- | ----------------------------------------------------------------------- |
| `CreateMerkleDistribution` | Authority | Store the week's root, create the vault, and fund it                    |
| `ClaimMerkle`              | Claimant  | Verify the wallet's leaf and proof, then transfer rewards               |
| `CloseMerkleDistribution`  | Authority | After `clawbackTs`, recover unclaimed tokens and close the vault        |
| `CloseMerkleClaim`         | Claimant  | After the distribution closes, close the claim PDA and recover its rent |

The leaf commits to the claimant wallet, total allocation, and vesting schedule. For this weekly flow, use the `Immediate` schedule consistently when constructing both the tree and claim instruction. Passing `amount = 0` to `ClaimMerkle` claims the full currently available amount.

The first claim creates a per-wallet `MerkleClaim` PDA to prevent double claiming. Its payer can be the claimant or a sponsored payer; rent is recoverable by the claimant after the distribution is closed.

## Backend responsibilities

- Make the weekly allocation snapshot deterministic and retain the exact input artifact.
- Reject duplicate wallets or combine them before building the tree.
- Use token base units throughout; never build leaves from decimal strings or floating-point values.
- Persist the distribution seed, address, root, total, `clawbackTs`, leaf data, and proof for every wallet.
- Rebuild and verify the root from the persisted artifact before submitting the create transaction.
- Do not expose a campaign until its create transaction is finalized and the vault balance is sufficient.
- Serve proofs only to the wallet encoded in the corresponding leaf.
- Keep old campaign artifacts available until the distribution and all relevant claim accounts are closed.

The repository's proof-bundle implementation is in [`apps/web/src/lib/proof-drop-bundle.ts`](apps/web/src/lib/proof-drop-bundle.ts). Generated TypeScript instruction builders are in [`clients/typescript`](clients/typescript).

## Accounts

| Account              | PDA seeds                                              | Purpose                                                     |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `MerkleDistribution` | `["merkle_distribution", mint, authority, seed]`       | Stores the root, authority, mint, totals, and clawback time |
| Distribution vault   | Associated token account owned by the distribution PDA | Holds the week's reward tokens                              |
| `MerkleClaim`        | `["merkle_claim", distribution, claimant]`             | Tracks the amount already claimed by one wallet             |

## Local development

Requirements: Rust, Node.js from [`.nvmrc`](.nvmrc), pnpm from [`package.json`](package.json), Solana CLI 4.0.0, and `just`.

```bash
just install
just build
just unit-test
just integration-test
```

Deploy to devnet with the local program keypair:

```bash
solana config set --url devnet
solana program deploy target/deploy/rewards_program.so \
  --program-id .keypairs/rewards-program.json
```

The keypair under `.keypairs/` is intentionally gitignored. Back it up securely before deployment. The program's upgrade authority should be a controlled multisig before production use.

## Audit provenance

This fork is based on Solana Foundation Rewards commit [`5006e14`](https://github.com/solana-foundation/rewards/commit/5006e14d8fe3e4f691be43ccbaaf7367908e80b3). The upstream program was audited by OtterSec; see [`audits/2026-ottersec-solana-foundation-rewards-audit.pdf`](audits/2026-ottersec-solana-foundation-rewards-audit.pdf) and [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md).

The upstream audit does not automatically attest to this fork's deployment, operational setup, or later changes. Review the exact deployed commit and verify the program binary before mainnet use.

## License

MIT. See [`LICENSE`](LICENSE).

Security reports: [open a private advisory](https://github.com/sendaifun/merkle-rewards/security/advisories/new).
