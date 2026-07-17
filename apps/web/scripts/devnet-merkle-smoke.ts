import { readFile } from 'node:fs/promises';

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import {
    getClaimMerkleInstruction,
    getCloseMerkleClaimInstruction,
    getCloseMerkleDistributionInstruction,
    getCreateMerkleDistributionInstruction,
    getVestingScheduleEncoder,
    type VestingScheduleArgs,
} from '@solana/rewards';
import { PublicKey } from '@solana/web3.js';

const RPC_URL = 'https://api.devnet.solana.com';
const RPC_SUBSCRIPTIONS_URL = 'wss://api.devnet.solana.com';
const PROGRAM_ID = 'T4RpCJXznFSw9atB4mmmDbZjUeDrxXDMUjV3qxEsuzi';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const IMMEDIATE_SCHEDULE = { __kind: 'Immediate' } as const satisfies VestingScheduleArgs;
const ALLOCATIONS = [100n, 200n, 300n] as const;
const CLAWBACK_DELAY_SECONDS = 90n;

interface Recipient {
    readonly allocation: bigint;
    readonly ata: Address;
    readonly proof: number[][];
    readonly signer: KeyPairSigner;
}

function usage(): never {
    throw new Error(
        'Usage: pnpm exec tsx apps/web/scripts/devnet-merkle-smoke.ts <mint> <authority-keypair> <claimant-1-keypair> <claimant-2-keypair> <claimant-3-keypair>',
    );
}

async function loadSigner(path: string) {
    const bytes = new Uint8Array(JSON.parse(await readFile(path, 'utf8')) as number[]);
    return await createKeyPairSignerFromBytes(bytes);
}

function concatBytes(...arrays: readonly Uint8Array[]) {
    const size = arrays.reduce((sum, value) => sum + value.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const value of arrays) {
        result.set(value, offset);
        offset += value.length;
    }
    return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return a.length - b.length;
}

function u64Le(value: bigint) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function leafHash(claimant: Address, totalAmount: bigint) {
    const scheduleBytes = Uint8Array.from(getVestingScheduleEncoder().encode(IMMEDIATE_SCHEDULE));
    const inner = keccak_256(concatBytes(new PublicKey(claimant).toBytes(), u64Le(totalAmount), scheduleBytes));
    return keccak_256(concatBytes(new Uint8Array([0]), inner));
}

function pairHash(a: Uint8Array, b: Uint8Array) {
    const [left, right] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
    return keccak_256(concatBytes(left, right));
}

function buildMerkleTree(leaves: readonly Uint8Array[]) {
    const proofs = leaves.map((): Uint8Array[] => []);
    let level = leaves
        .map((hash, index) => ({ hash, leafIndexes: [index] }))
        .sort((a, b) => compareBytes(a.hash, b.hash));

    while (level.length > 1) {
        const next: typeof level = [];
        for (let index = 0; index < level.length; index += 2) {
            const left = level[index]!;
            const right = level[index + 1];
            if (!right) {
                next.push(left);
                continue;
            }
            for (const leafIndex of left.leafIndexes) proofs[leafIndex]!.push(right.hash);
            for (const leafIndex of right.leafIndexes) proofs[leafIndex]!.push(left.hash);
            next.push({
                hash: pairHash(left.hash, right.hash),
                leafIndexes: [...left.leafIndexes, ...right.leafIndexes],
            });
        }
        level = next;
    }

    return { proofs, root: level[0]!.hash };
}

function derivePda(seeds: Uint8Array[], programId: string) {
    const [value, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
    return [address(value.toBase58()), bump] as const;
}

function publicKeyBytes(value: Address) {
    return new PublicKey(value).toBytes();
}

function deriveAta(owner: Address, mint: Address) {
    return derivePda(
        [publicKeyBytes(owner), new PublicKey(TOKEN_PROGRAM_ID).toBytes(), publicKeyBytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
}

function explorer(signature: string) {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

async function main() {
    const [mintArg, authorityPath, ...claimantPaths] = process.argv.slice(2);
    if (!mintArg || !authorityPath || claimantPaths.length !== 3) usage();

    const mint = address(mintArg);
    const authority = await loadSigner(authorityPath);
    const claimantSigners = await Promise.all(claimantPaths.map(loadSigner));
    const seed = await generateKeyPairSigner();
    const programAddress = address(PROGRAM_ID);
    const tokenProgram = address(TOKEN_PROGRAM_ID);

    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    async function send(label: string, instructions: readonly Instruction[]) {
        const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            transaction => setTransactionMessageFeePayerSigner(authority, transaction),
            transaction => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, transaction),
            transaction => appendTransactionMessageInstructions(instructions, transaction),
        );
        const signed = await signTransactionMessageWithSigners(message);
        const signature = getSignatureFromTransaction(signed);
        assertIsTransactionWithBlockhashLifetime(signed);
        await sendAndConfirm(signed, { commitment: 'confirmed' });
        console.log(`${label}: ${signature}`);
        console.log(`  ${explorer(signature)}`);
        return signature;
    }

    async function tokenBalance(tokenAccount: Address) {
        const response = await rpc.getTokenAccountBalance(tokenAccount, { commitment: 'confirmed' }).send();
        return BigInt(response.value.amount);
    }

    async function chainTimestamp() {
        const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
        const timestamp = await rpc.getBlockTime(slot).send();
        if (timestamp === null) throw new Error(`No block time available for slot ${slot}`);
        return timestamp;
    }

    const [distribution, distributionBump] = derivePda(
        [
            new TextEncoder().encode('merkle_distribution'),
            publicKeyBytes(mint),
            publicKeyBytes(authority.address),
            publicKeyBytes(seed.address),
        ],
        PROGRAM_ID,
    );
    const distributionVault = deriveAta(distribution, mint);
    const authorityTokenAccount = deriveAta(authority.address, mint);
    const eventAuthority = derivePda([new TextEncoder().encode('event_authority')], PROGRAM_ID)[0];
    const leaves = claimantSigners.map((signer, index) => leafHash(signer.address, ALLOCATIONS[index]!));
    const { proofs, root } = buildMerkleTree(leaves);
    const clawbackTs = (await chainTimestamp()) + CLAWBACK_DELAY_SECONDS;
    const totalAmount = ALLOCATIONS.reduce((sum, allocation) => sum + allocation, 0n);

    const recipients: Recipient[] = claimantSigners.map((signer, index) => ({
        allocation: ALLOCATIONS[index]!,
        ata: deriveAta(signer.address, mint),
        proof: proofs[index]!.map(node => Array.from(node)),
        signer,
    }));

    console.log(`authority: ${authority.address}`);
    console.log(`mint: ${mint}`);
    console.log(`distribution: ${distribution}`);
    console.log(`vault: ${distributionVault}`);
    console.log(`seed: ${seed.address}`);
    console.log(`root: ${Buffer.from(root).toString('hex')}`);
    console.log(`clawbackTs: ${clawbackTs}`);
    recipients.forEach((recipient, index) => {
        console.log(`claimant ${index + 1}: ${recipient.signer.address} (${recipient.allocation} tokens)`);
    });

    const treasuryBefore = await tokenBalance(authorityTokenAccount);
    if (treasuryBefore !== totalAmount) {
        throw new Error(`Expected treasury balance ${totalAmount}, received ${treasuryBefore}`);
    }

    await send('create distribution', [
        getCreateMerkleDistributionInstruction(
            {
                amount: totalAmount,
                authority,
                authorityTokenAccount,
                bump: distributionBump,
                clawbackTs,
                distribution,
                distributionVault,
                eventAuthority,
                merkleRoot: Array.from(root),
                mint,
                payer: authority,
                revocable: 0,
                seeds: seed,
                tokenProgram,
                totalAmount,
            },
            { programAddress },
        ),
    ]);

    if ((await tokenBalance(distributionVault)) !== totalAmount) {
        throw new Error('Distribution vault was not funded with the full allocation');
    }

    const claimAccounts: Address[] = [];
    for (const recipient of recipients.slice(0, 2)) {
        const [claimAccount, claimBump] = derivePda(
            [
                new TextEncoder().encode('merkle_claim'),
                publicKeyBytes(distribution),
                publicKeyBytes(recipient.signer.address),
            ],
            PROGRAM_ID,
        );
        const revocationMarker = derivePda(
            [
                new TextEncoder().encode('revocation'),
                publicKeyBytes(distribution),
                publicKeyBytes(recipient.signer.address),
            ],
            PROGRAM_ID,
        )[0];
        claimAccounts.push(claimAccount);
        await send(`claim ${recipient.allocation}`, [
            getClaimMerkleInstruction(
                {
                    amount: 0,
                    claimAccount,
                    claimBump,
                    claimant: recipient.signer,
                    claimantTokenAccount: recipient.ata,
                    distribution,
                    distributionVault,
                    eventAuthority,
                    mint,
                    payer: authority,
                    proof: recipient.proof,
                    revocationMarker,
                    schedule: IMMEDIATE_SCHEDULE,
                    tokenProgram,
                    totalAmount: recipient.allocation,
                },
                { programAddress },
            ),
        ]);
    }

    const claimedBalances = await Promise.all(recipients.map(recipient => tokenBalance(recipient.ata)));
    const expectedClaimedBalances = [100n, 200n, 0n];
    if (claimedBalances.some((value, index) => value !== expectedClaimedBalances[index])) {
        throw new Error(`Unexpected claimant balances: ${claimedBalances.join(', ')}`);
    }
    if ((await tokenBalance(distributionVault)) !== 300n) {
        throw new Error('Expected the unclaimed 300 tokens to remain in the distribution vault');
    }

    const first = recipients[0]!;
    const firstClaimAccount = claimAccounts[0]!;
    const firstRevocationMarker = derivePda(
        [new TextEncoder().encode('revocation'), publicKeyBytes(distribution), publicKeyBytes(first.signer.address)],
        PROGRAM_ID,
    )[0];
    try {
        await send('unexpected duplicate claim', [
            getClaimMerkleInstruction(
                {
                    amount: 0,
                    claimAccount: firstClaimAccount,
                    claimBump: derivePda(
                        [
                            new TextEncoder().encode('merkle_claim'),
                            publicKeyBytes(distribution),
                            publicKeyBytes(first.signer.address),
                        ],
                        PROGRAM_ID,
                    )[1],
                    claimant: first.signer,
                    claimantTokenAccount: first.ata,
                    distribution,
                    distributionVault,
                    eventAuthority,
                    mint,
                    payer: authority,
                    proof: first.proof,
                    revocationMarker: firstRevocationMarker,
                    schedule: IMMEDIATE_SCHEDULE,
                    tokenProgram,
                    totalAmount: first.allocation,
                },
                { programAddress },
            ),
        ]);
        throw new Error('Duplicate claim unexpectedly succeeded');
    } catch (error) {
        if (error instanceof Error && error.message === 'Duplicate claim unexpectedly succeeded') throw error;
        console.log('duplicate claim: correctly rejected');
    }

    const closeInstruction = getCloseMerkleDistributionInstruction(
        {
            authority,
            authorityTokenAccount,
            distribution,
            distributionVault,
            eventAuthority,
            mint,
            tokenProgram,
        },
        { programAddress },
    );
    try {
        await send('unexpected early close', [closeInstruction]);
        throw new Error('Early close unexpectedly succeeded');
    } catch (error) {
        if (error instanceof Error && error.message === 'Early close unexpectedly succeeded') throw error;
        console.log('early close: correctly rejected');
    }

    while ((await chainTimestamp()) < clawbackTs) {
        const remaining = clawbackTs - (await chainTimestamp());
        console.log(`waiting for clawback: ${remaining}s`);
        await new Promise(resolve => setTimeout(resolve, Number(remaining > 15n ? 15n : remaining + 2n) * 1000));
    }

    await send('close distribution', [closeInstruction]);
    if ((await tokenBalance(authorityTokenAccount)) !== 300n) {
        throw new Error('Unclaimed allocation was not returned to treasury');
    }

    for (let index = 0; index < 2; index += 1) {
        await send(`close claim ${index + 1}`, [
            getCloseMerkleClaimInstruction(
                {
                    claimAccount: claimAccounts[index]!,
                    claimant: recipients[index]!.signer,
                    distribution,
                    eventAuthority,
                },
                { programAddress },
            ),
        ]);
    }

    const finalBalances = await Promise.all(recipients.map(recipient => tokenBalance(recipient.ata)));
    console.log('PASS');
    console.log(
        JSON.stringify(
            {
                authority: authority.address,
                claimantBalances: finalBalances.map(String),
                distribution,
                mint,
                treasuryRecovered: String(await tokenBalance(authorityTokenAccount)),
                vaultClosed: true,
            },
            null,
            2,
        ),
    );
}

await main();
